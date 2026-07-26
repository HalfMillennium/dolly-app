//
//  Renderer.swift
//  dollyd
//
//  Native export composition (BUILD_PLAN §2.3, §6.3, §6.6).
//
//  This is one of the two renderers that MUST agree (§2.3). The preview renderer is the
//  webview 2D canvas; this is the export renderer. Both consume the same project.json and the
//  same shared math (RenderMath.swift <- packages/schema/src/math.ts). The §6.6 parity test
//  compares their PNGs pixel-for-pixel.
//
//  Composition order — MUST match the §6.3 preview order exactly:
//    1. fill backdrop (CILinearGradient / solid)
//    2. compute content rect (RenderMath.contentRect: inset by padding*min(W,H), aspect-fit)
//    3. shadow rounded rect (CIGaussianBlur of a rounded-rect fill, offset by shadow.y)
//    4. clip rounded rect (rounded-rect mask)
//    5. zoom transform about focal (RenderMath.zoomTransform)
//    6. draw source image (the decoded video frame)
//    7. synthetic cursor, scaled by 1/zoomScale (§6.5)
//    8. (editor-only overlays are NEVER drawn in export)
//
//  Implementation is a Core Image chain rendered with CIContext(mtlDevice:). A Metal
//  single-pass fallback stub is documented at the bottom (§6.6) for the 4K60 case where CI
//  can't hold frame rate.
//
import CoreGraphics
import CoreImage
import Foundation
import Metal

/// Immutable per-export render inputs derived from project.json, plus the cursor track for
/// the synthetic cursor. Built once; `render(frame:atTime:)` is called per frame.
final class Renderer {

    let project: Project
    let outputSize: CGSize        // canvas size in pixels (the export resolution)
    let cursor: CursorTrack       // parsed cursor.jsonl (for synthetic cursor + follow focal)

    private let ciContext: CIContext
    private let srcAspect: Double

    // Follow-focal spring state, advanced frame to frame for "follow" zooms (§6.3).
    private var focalSpring = Spring2D(x: SpringState(pos: 0.5, vel: 0),
                                       y: SpringState(pos: 0.5, vel: 0))
    private var lastRenderTime: Double?

    // Cursor smoothing filters (One Euro + spring), advanced frame to frame (§6.5).
    private let cursorFilterX = OneEuroFilter()
    private let cursorFilterY = OneEuroFilter()
    private var cursorSpring = Spring2D(x: SpringState(pos: 0.5, vel: 0),
                                        y: SpringState(pos: 0.5, vel: 0))

    init(project: Project, outputSize: CGSize, cursor: CursorTrack, mtlDevice: MTLDevice?) {
        self.project = project
        self.outputSize = outputSize
        self.cursor = cursor
        self.srcAspect = Double(project.source.width) / Double(project.source.height)
        if let device = mtlDevice ?? MTLCreateSystemDefaultDevice() {
            self.ciContext = CIContext(mtlDevice: device)
        } else {
            // Software fallback (slow) — should not happen on real hardware.
            self.ciContext = CIContext()
        }
    }

    // MARK: - Public entry

    /// Compose one output frame. `frame` is the decoded source video pixels (already the raw
    /// captured surface, no cursor per §2.5). `t` is the project timeline seconds.
    /// Returns a CIImage in the output coordinate space (origin bottom-left, Core Image
    /// convention) sized `outputSize`.
    func render(frame sourceImage: CIImage, atTime t: Double) -> CIImage {
        let W = Double(outputSize.width)
        let H = Double(outputSize.height)

        // dt for the springs (follow focal, cursor). First frame: dt=0 (no motion).
        let dt: Double
        if let last = lastRenderTime { dt = max(0, t - last) } else { dt = 0 }
        lastRenderTime = t

        // 1. Backdrop -----------------------------------------------------------------------
        var output = makeBackdrop(width: W, height: H)

        // 2. Content rect -------------------------------------------------------------------
        let content = contentRect(W, H, srcAspect, project.composition.padding)

        // 5(pre). Zoom scale + focal at this time -------------------------------------------
        let (scale, focal) = zoomStateAt(t: t, content: content, dt: dt)
        let zoom = zoomTransform(content, scale, focal) // RenderMath (shared, clamped)

        // Normalize the source image to the content rect first (fit source pixels into the
        // content rect), THEN apply the zoom transform about the focal. This mirrors the
        // canvas order: the source is drawn into `content`, then scaled about the focal.
        let srcExtent = sourceImage.extent
        let fitToContent = CGAffineTransform.identity
            .translatedBy(x: CGFloat(content.x), y: CGFloat(content.y))
            .scaledBy(x: CGFloat(content.w) / srcExtent.width,
                      y: CGFloat(content.h) / srcExtent.height)

        // Compose fit -> zoom. NOTE the coordinate flip: RenderMath / the TS canvas use a
        // TOP-LEFT origin, but Core Image uses BOTTOM-LEFT. We render the whole composition in
        // a top-left virtual space and flip once at the very end (see `flipY`). Working in a
        // single consistent space is what keeps parity exact.
        let zoomCG = zoom.cgAffine
        let placedSource = sourceImage
            .transformed(by: fitToContent)
            .transformed(by: zoomCG)

        // 4. Rounded-rect mask (clip) — built in the zoomed content space -------------------
        // The rounded rect is the content rect, transformed by the same zoom so the corners
        // scale with the frame (as in the preview: clip is applied, then zoom).
        let radius = project.composition.radius
        let maskRect = CGRect(x: content.x, y: content.y, width: content.w, height: content.h)
            .applying(zoomCG)
        let scaledRadius = radius * scale

        // 3. Shadow (drawn BEFORE the clipped frame, behind it) -----------------------------
        if project.composition.shadow.enabled {
            let shadow = makeShadow(rect: maskRect, radius: scaledRadius,
                                    canvasW: W, canvasH: H)
            output = shadow.composited(over: output)
        }

        // 4+6. Clip the placed source to the rounded rect, then composite over backdrop ------
        let roundedMask = roundedRectMask(rect: maskRect, radius: scaledRadius,
                                          canvasW: W, canvasH: H)
        let clipped = placedSource.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: CIImage.empty(),
            kCIInputMaskImageKey: roundedMask
        ])
        output = clipped.composited(over: output)

        // 7. Synthetic cursor (scaled by 1/zoomScale) ---------------------------------------
        if project.cursor.visible {
            if let cursorImage = makeCursor(t: t, content: content, zoom: zoomCG,
                                            zoomScale: scale, dt: dt) {
                output = cursorImage.composited(over: output)
            }
        }

        // Crop to the canvas and flip to Core Image's bottom-left origin for the writer.
        let cropped = output.cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        return flipY(cropped, height: H)
    }

    /// Render a composed frame into a CVPixelBuffer (for the AVAssetWriter pool).
    func renderToPixelBuffer(_ image: CIImage, _ buffer: CVPixelBuffer) {
        ciContext.render(image, to: buffer)
    }

    // MARK: - Zoom state (scale + focal) at a time

    /// Aggregate zoom scale + focal across all zoom segments active at time `t`. For a single
    /// active segment (the common case) this is `zoomScaleAt` + its focal; overlapping
    /// segments are resolved upstream by auto-zoom (§6.4 step 6) so at most one is active.
    private func zoomStateAt(t: Double, content: RMRect, dt: Double) -> (scale: Double, focal: RMFocal) {
        var best: Zoom?
        for z in project.zooms where t > z.start && t < z.end {
            best = z
            break
        }
        guard let z = best else {
            // Reset the follow spring toward center when no zoom is active.
            return (1.0, RMFocal(x: 0.5, y: 0.5))
        }
        let ramp = ZoomRamp(start: z.start, end: z.end, scale: z.scale,
                            rampIn: z.rampIn, rampOut: z.rampOut, easing: z.easing)
        let scale = zoomScaleAt(ramp, t)

        switch z.focal {
        case let .fixed(x, y):
            return (scale, RMFocal(x: x, y: y))
        case let .follow(damping, _):
            // Drive the focal spring toward the smoothed cursor position (§6.3 follow mode).
            let target = cursor.smoothedPosition(at: t) ?? RMFocal(x: 0.5, y: 0.5)
            focalSpring = spring2DStep(focalSpring, (x: target.x, y: target.y), damping, dt)
            return (scale, RMFocal(x: focalSpring.x.pos, y: focalSpring.y.pos))
        }
    }

    // MARK: - Backdrop (§6.3 step 1)

    private func makeBackdrop(width W: Double, height H: Double) -> CIImage {
        switch project.composition.backdrop {
        case let .solid(color):
            let c = CIColor(hex: color)
            return CIImage(color: c).cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        case let .gradient(from, to, angle):
            // CILinearGradient from one corner to another along `angle` degrees.
            let c0 = CIColor(hex: from)
            let c1 = CIColor(hex: to)
            let rad = angle * .pi / 180.0
            // A gradient line through the center at `angle`, spanning the canvas diagonal.
            let cx = W / 2, cy = H / 2
            let half = (W * abs(cos(rad)) + H * abs(sin(rad))) / 2
            let p0 = CIVector(x: CGFloat(cx - half * cos(rad)), y: CGFloat(cy - half * sin(rad)))
            let p1 = CIVector(x: CGFloat(cx + half * cos(rad)), y: CGFloat(cy + half * sin(rad)))
            let grad = CIFilter(name: "CILinearGradient", parameters: [
                "inputPoint0": p0, "inputColor0": c0,
                "inputPoint1": p1, "inputColor1": c1
            ])!.outputImage!
            return grad.cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        }
    }

    // MARK: - Rounded-rect mask & shadow (§6.3 steps 3–4, §6.6)

    /// A white rounded rectangle on transparent, used as the clip mask.
    private func roundedRectMask(rect: CGRect, radius: Double,
                                 canvasW: Double, canvasH: Double) -> CIImage {
        // CIRoundedRectangleGenerator (macOS 14+) is the clean path.
        // TODO(mac): if unavailable, draw the rounded rect into a CGContext bitmap and wrap in
        // a CIImage. The generator produces the fill color inside a rounded rect of `extent`.
        let filter = CIFilter(name: "CIRoundedRectangleGenerator", parameters: [
            "inputExtent": CIVector(cgRect: rect),
            "inputRadius": radius,
            "inputColor": CIColor.white
        ])
        let mask = filter?.outputImage ?? CIImage(color: .white).cropped(to: rect)
        return mask.cropped(to: CGRect(x: 0, y: 0, width: canvasW, height: canvasH))
    }

    /// A soft drop shadow: a black rounded rect, gaussian-blurred, offset down by shadow.y,
    /// at shadow.opacity (§6.3 step 3, §6.6 CIGaussianBlur).
    private func makeShadow(rect: CGRect, radius: Double,
                            canvasW: Double, canvasH: Double) -> CIImage {
        let shadow = project.composition.shadow
        let black = CIColor(red: 0, green: 0, blue: 0, alpha: CGFloat(shadow.opacity))
        let filled = CIFilter(name: "CIRoundedRectangleGenerator", parameters: [
            "inputExtent": CIVector(cgRect: rect),
            "inputRadius": radius,
            "inputColor": black
        ])?.outputImage ?? CIImage(color: black).cropped(to: rect)
        // Offset downward. Note: this is in the top-left virtual space; positive y is DOWN in
        // the preview, so we translate by -shadow.y here because the final flipY inverts it.
        let offset = filled.transformed(by: CGAffineTransform(translationX: 0,
                                                              y: CGFloat(shadow.y)))
        let blurred = offset.applyingFilter("CIGaussianBlur",
                                            parameters: [kCIInputRadiusKey: shadow.blur])
        return blurred.cropped(to: CGRect(x: 0, y: 0, width: canvasW, height: canvasH))
    }

    // MARK: - Synthetic cursor (§6.5)

    /// Draw the synthetic cursor at the smoothed position, scaled by cursor.size * (1/zoom).
    /// Includes the click-ripple (§6.5) if enabled and a click is near `t`.
    private func makeCursor(t: Double, content: RMRect, zoom: CGAffineTransform,
                            zoomScale: Double, dt: Double) -> CIImage? {
        guard let pos = cursor.smoothedPosition(at: t) else { return nil }
        // hideWhenIdle fade (§6.5): if no movement for hideWhenIdle seconds, fade out.
        let idle = cursor.idleSeconds(at: t)
        let hideWhenIdle = project.cursor.hideWhenIdle
        var alpha = 1.0
        if hideWhenIdle > 0 && idle > hideWhenIdle {
            // Fade over 0.3s past the threshold.
            alpha = clamp(1.0 - (idle - hideWhenIdle) / 0.3, 0, 1)
            if alpha <= 0 { return nil }
        }

        // Position in source-normalized -> content-space point -> apply zoom (same transform
        // as the frame so the cursor tracks the pixel under it).
        let px = content.x + pos.x * content.w
        let py = content.y + pos.y * content.h
        let placed = CGPoint(x: px, y: py).applying(zoom)

        // Cursor bitmap: a bundled SVG arrow rasterized (§6.5 "bundled SVG arrow/I-beam paths,
        // not the 24px system bitmap"). We build it via CoreGraphics here as a stand-in.
        // TODO(mac): load the real bundled arrow.svg / ibeam.svg and rasterize to the needed
        // size; pick I-beam when hovering text if we ever detect it. For now, arrow only.
        let cursorScale = project.cursor.size * (1.0 / zoomScale)
        guard let bitmap = CursorArtwork.arrowImage(scale: cursorScale, alpha: alpha) else {
            return nil
        }
        // Place the hotspot (tip) at `placed`. Arrow hotspot is top-left of its bitmap.
        var image = bitmap.transformed(by: CGAffineTransform(
            translationX: placed.x, y: placed.y - bitmap.extent.height))

        // Click ripple (§6.5): expanding ring, 350ms, cubicOut, opacity 0.5 -> 0.
        if project.cursor.clickRipple, let click = cursor.lastClick(before: t, within: 0.35) {
            let age = t - click.t
            let p = cubicOut(age / 0.35)
            let ringRadius = 8.0 + 40.0 * p * cursorScale
            let ringAlpha = 0.5 * (1.0 - p)
            if let ripple = CursorArtwork.rippleImage(center: placed, radius: ringRadius,
                                                      alpha: ringAlpha) {
                image = image.composited(over: ripple)
            }
        }
        return image
    }

    // MARK: - Coordinate flip

    /// Flip the composed top-left-origin image to Core Image's bottom-left origin.
    private func flipY(_ image: CIImage, height H: Double) -> CIImage {
        return image.transformed(by: CGAffineTransform(a: 1, b: 0, c: 0, d: -1,
                                                       tx: 0, ty: CGFloat(H)))
    }
}

// MARK: - Metal single-pass fallback (§6.6 documented stub)

/// If the Core Image chain cannot hold 60fps at 4K, §6.6 calls for a Metal single-pass
/// compositor: one fragment shader that samples the source, applies the zoom transform,
/// rounded-rect SDF mask, shadow and gradient in a single draw. This is intentionally a stub;
/// the CI path above is the primary implementation.
///
/// TODO(mac): implement only if profiling on-device shows CI < 60fps at 4K. The shader would:
///   - take zoom (a,b,c,d,e,f), content rect, radius, shadow params, gradient endpoints as a
///     uniform buffer (all derived from the SAME RenderMath values, so parity holds),
///   - render a full-screen triangle, computing the rounded-rect SDF for the mask and shadow,
///   - sample the source texture through the inverse zoom transform.
/// Keeping the math in RenderMath.swift means the Metal path and the CI path stay in parity.
enum MetalCompositor {
    static let isEnabled = false // flip on-device if CI is too slow (§6.6)
}
