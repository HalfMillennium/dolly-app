//
//  RenderMath.swift
//  dollyd
//
//  Swift port of `packages/schema/src/math.ts` — the SINGLE SOURCE OF TRUTH is the
//  TypeScript file; this is its mirror. These functions MUST be identical to the TS preview
//  renderer (BUILD_PLAN §2.3, §6.6). Preview/export divergence is the largest correctness
//  risk in the product; the parity test (§6.6, ParityTests.swift) exists to catch drift, and
//  these functions exist to prevent it.
//
//  When math.ts changes, mirror it here and keep ParityTests green. Do NOT "improve" a
//  formula on one side only.
//
//  Source of truth: packages/schema/src/math.ts
//
//  Convention note: the TS side uses the CanvasRenderingContext2D (a,b,c,d,e,f) affine
//  convention:  x' = a*x + c*y + e ;  y' = b*x + d*y + f.  CoreGraphics `CGAffineTransform`
//  uses the SAME six-field layout but with field names (a,b,c,d,tx,ty) — so a Mat2D maps to
//  CGAffineTransform(a:a, b:b, c:c, d:d, tx:e, ty:f). See `Mat2D.cgAffine` below.
//
import CoreGraphics
import Foundation

// MARK: - Value types (mirror the TS interfaces)

/// A 2D affine transform in the CanvasRenderingContext2D (a,b,c,d,e,f) convention.
public struct Mat2D: Equatable {
    public var a: Double
    public var b: Double
    public var c: Double
    public var d: Double
    public var e: Double
    public var f: Double

    public init(a: Double, b: Double, c: Double, d: Double, e: Double, f: Double) {
        self.a = a; self.b = b; self.c = c; self.d = d; self.e = e; self.f = f
    }

    /// Bridge to CoreGraphics. CGAffineTransform's tx/ty are the canvas e/f.
    public var cgAffine: CGAffineTransform {
        CGAffineTransform(a: CGFloat(a), b: CGFloat(b), c: CGFloat(c), d: CGFloat(d),
                          tx: CGFloat(e), ty: CGFloat(f))
    }
}

/// An axis-aligned rectangle (the aspect-fit "content rect" the source video is drawn into).
public struct RMRect: Equatable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }
}

/// A focal point in source-normalized [0,1] coordinates, origin top-left.
public struct RMFocal: Equatable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

// MARK: - clamp

@inline(__always)
public func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
    return v < lo ? lo : (v > hi ? hi : v)
}

// MARK: - Focal clamp (math.ts focalClamp)

/// Clamp a zoom focal point so that a scale-`s` zoom never lets the backdrop bleed through at
/// the edges of the content rect (BUILD_PLAN §6.3). At scale `s`, the visible normalized
/// half-window is 1/(2s); the focal must stay at least that far from each edge.
///
/// For s <= 1 the window covers the whole frame, so the focal collapses to the center.
public func focalClamp(_ focal: RMFocal, _ s: Double) -> RMFocal {
    if s <= 1 { return RMFocal(x: 0.5, y: 0.5) }
    let m = 1.0 / (2.0 * s)
    return RMFocal(x: clamp(focal.x, m, 1 - m), y: clamp(focal.y, m, 1 - m))
}

// MARK: - Zoom transform (math.ts zoomMatrix / zoomTransform)

/// Compose the zoom transform about an ALREADY-CLAMPED focal (BUILD_PLAN §6.3). Equivalent to
/// the canvas ops: translate(cx, cy); scale(s, s); translate(-px, -py). Does not clamp.
public func zoomMatrix(_ content: RMRect, _ s: Double, _ focal: RMFocal) -> Mat2D {
    let px = content.x + focal.x * content.w
    let py = content.y + focal.y * content.h
    let cx = content.x + content.w / 2
    let cy = content.y + content.h / 2
    return Mat2D(a: s, b: 0, c: 0, d: s, e: cx - s * px, f: cy - s * py)
}

/// Convenience: clamp the focal for scale `s`, then compose the transform.
public func zoomTransform(_ content: RMRect, _ s: Double, _ focal: RMFocal) -> Mat2D {
    return zoomMatrix(content, s, focalClamp(focal, s))
}

/// Apply a Mat2D to a point.
public func applyMat(_ m: Mat2D, _ x: Double, _ y: Double) -> (x: Double, y: Double) {
    return (x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f)
}

// MARK: - Easing (math.ts cubicInOut / cubicOut / ease)

/// cubicInOut easing on [0,1].
public func cubicInOut(_ t: Double) -> Double {
    let u = clamp(t, 0, 1)
    return u < 0.5 ? 4 * u * u * u : 1 - pow(-2 * u + 2, 3) / 2
}

/// cubicOut easing on [0,1] (used for the click ripple, BUILD_PLAN §6.5).
public func cubicOut(_ t: Double) -> Double {
    let u = clamp(t, 0, 1)
    return 1 - pow(1 - u, 3)
}

public enum Easing: String, Codable {
    case cubicInOut
    case cubicOut
    case linear
}

public func ease(_ kind: Easing, _ t: Double) -> Double {
    switch kind {
    case .cubicInOut: return cubicInOut(t)
    case .cubicOut: return cubicOut(t)
    case .linear: return clamp(t, 0, 1)
    }
}

// MARK: - Zoom scale over time (math.ts zoomScaleAt)

public struct ZoomRamp {
    public var start: Double
    public var end: Double
    public var scale: Double
    public var rampIn: Double
    public var rampOut: Double
    public var easing: Easing
    public init(start: Double, end: Double, scale: Double, rampIn: Double, rampOut: Double, easing: Easing) {
        self.start = start; self.end = end; self.scale = scale
        self.rampIn = rampIn; self.rampOut = rampOut; self.easing = easing
    }
}

/// The effective zoom scale at time `t` for a single zoom segment, interpolating from 1.0 up
/// to `scale` across `rampIn`, holding, then back to 1.0 across `rampOut` (BUILD_PLAN §6.3).
/// Outside the segment the scale is 1.0. Ramps are clamped so they never overlap past the
/// segment midpoint.
public func zoomScaleAt(_ z: ZoomRamp, _ t: Double) -> Double {
    if t <= z.start || t >= z.end { return 1 }
    let dur = z.end - z.start
    let rampIn = min(z.rampIn, dur / 2)
    let rampOut = min(z.rampOut, dur / 2)
    let local = t - z.start
    if local < rampIn {
        return 1 + (z.scale - 1) * ease(z.easing, local / rampIn)
    }
    let fromEnd = z.end - t
    if fromEnd < rampOut {
        return 1 + (z.scale - 1) * ease(z.easing, fromEnd / rampOut)
    }
    return z.scale
}

// MARK: - Critically damped spring (math.ts springStep / spring2DStep)

public struct SpringState: Equatable {
    public var pos: Double
    public var vel: Double
    public init(pos: Double, vel: Double) { self.pos = pos; self.vel = vel }
}

/// One integration step of the critically damped spring (BUILD_PLAN §6.3, §6.5):
///
///   omega = 2*pi / damping
///   k     = 1 - exp(-omega*dt)
///   vel  += (target - pos) * k
///   pos  += vel * dt
///   vel  *= exp(-omega*dt)
///
/// `damping` ~0.12 -> stiff, ~0.4 -> loose. `dt` is seconds. Pure: input is not mutated.
public func springStep(_ state: SpringState, _ target: Double, _ damping: Double, _ dt: Double) -> SpringState {
    let omega = (2 * Double.pi) / damping
    let decay = exp(-omega * dt)
    let k = 1 - decay
    var vel = state.vel + (target - state.pos) * k
    let pos = state.pos + vel * dt
    vel *= decay
    return SpringState(pos: pos, vel: vel)
}

public struct Spring2D: Equatable {
    public var x: SpringState
    public var y: SpringState
    public init(x: SpringState, y: SpringState) { self.x = x; self.y = y }
}

public func spring2DStep(_ s: Spring2D, _ target: (x: Double, y: Double), _ damping: Double, _ dt: Double) -> Spring2D {
    return Spring2D(x: springStep(s.x, target.x, damping, dt),
                    y: springStep(s.y, target.y, damping, dt))
}

// MARK: - One Euro filter (math.ts OneEuroFilter)

/// The 1€ (One Euro) low-pass filter (Casiez, Roussel, Vogel 2012). Removes cursor jitter
/// before clustering (auto-zoom) and before rendering the synthetic cursor.
///
/// `minCutoff` and `beta` default to the BUILD_PLAN §6.4 constants (1.0 / 0.02). Stateful;
/// expects strictly increasing timestamps (seconds).
public final class OneEuroFilter {
    private let minCutoff: Double
    private let beta: Double
    private let dCutoff: Double
    private var xPrev: Double?
    private var dxPrev: Double = 0
    private var tPrev: Double?

    public init(minCutoff: Double = 1.0, beta: Double = 0.02, dCutoff: Double = 1.0) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.dCutoff = dCutoff
    }

    private static func alpha(_ cutoff: Double, _ dt: Double) -> Double {
        let tau = 1.0 / (2.0 * Double.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)
    }

    /// Filter a sample taken at time `t` (seconds). First sample passes through unchanged.
    @discardableResult
    public func filter(_ x: Double, _ t: Double) -> Double {
        guard let tPrev = tPrev, let xPrev = xPrev else {
            self.tPrev = t
            self.xPrev = x
            self.dxPrev = 0
            return x
        }
        let dt = t - tPrev
        if dt <= 0 { return xPrev } // ignore non-monotonic samples
        let dx = (x - xPrev) / dt
        let aD = OneEuroFilter.alpha(dCutoff, dt)
        let dxHat = aD * dx + (1 - aD) * dxPrev
        let cutoff = minCutoff + beta * abs(dxHat)
        let aX = OneEuroFilter.alpha(cutoff, dt)
        let xHat = aX * x + (1 - aX) * xPrev
        self.xPrev = xHat
        self.dxPrev = dxHat
        self.tPrev = t
        return xHat
    }

    public func reset() {
        xPrev = nil
        dxPrev = 0
        tPrev = nil
    }
}

// MARK: - Geometry helpers (math.ts contentRect / normDistance)

/// Compute the aspect-fit content rect: the canvas inset by `padding * min(W,H)`, then the
/// source aspect fit inside that inset box (BUILD_PLAN §6.3 step 2).
public func contentRect(_ canvasW: Double, _ canvasH: Double, _ srcAspect: Double, _ padding: Double) -> RMRect {
    let inset = padding * min(canvasW, canvasH)
    let boxW = canvasW - 2 * inset
    let boxH = canvasH - 2 * inset
    let boxAspect = boxW / boxH
    let w: Double
    let h: Double
    if srcAspect > boxAspect {
        w = boxW
        h = boxW / srcAspect
    } else {
        h = boxH
        w = boxH * srcAspect
    }
    return RMRect(x: inset + (boxW - w) / 2, y: inset + (boxH - h) / 2, w: w, h: h)
}

/// Euclidean distance between two normalized points, scaled to the [0,1]-square diagonal.
public func normDistance(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    let dx = ax - bx
    let dy = ay - by
    return (dx * dx + dy * dy).squareRoot() / 2.0.squareRoot()
}

// MARK: - Catmull-Rom spline (math.ts catmullRom / catmullRomAt — Cursorcraft feature)

/// A timestamped point on a cursor path; x/y normalized [0,1] top-left. Mirrors math.ts PathKey.
public struct RMPathKey {
    public let t: Double
    public let x: Double
    public let y: Double
    public init(t: Double, x: Double, y: Double) {
        self.t = t
        self.x = x
        self.y = y
    }
}

/// Uniform Catmull-Rom (tension 0.5) of one scalar across p0..p3 at local `u` in [0,1]
/// (segment p1 -> p2). MUST match math.ts `catmullRom` exactly — §6.6 parity.
public func catmullRom(_ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double, _ u: Double) -> Double {
    let u2 = u * u
    let u3 = u2 * u
    return 0.5
        * (2 * p1
            + (-p0 + p2) * u
            + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
            + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
}

/// Evaluate a Catmull-Rom cursor path at time `t`; clamps outside the key range. Mirrors
/// math.ts `catmullRomAt`. `keys` must be sorted by `t`.
public func catmullRomAt(_ keys: [RMPathKey], _ t: Double) -> RMFocal {
    let n = keys.count
    if n == 0 { return RMFocal(x: 0.5, y: 0.5) }
    if n == 1 { return RMFocal(x: keys[0].x, y: keys[0].y) }
    if t <= keys[0].t { return RMFocal(x: keys[0].x, y: keys[0].y) }
    let last = keys[n - 1]
    if t >= last.t { return RMFocal(x: last.x, y: last.y) }

    var lo = 0
    var hi = n - 1
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1
        if keys[mid].t <= t { lo = mid } else { hi = mid }
    }
    let p1 = keys[lo]
    let p2 = keys[hi]
    let p0 = lo - 1 >= 0 ? keys[lo - 1] : p1
    let p3 = hi + 1 < n ? keys[hi + 1] : p2
    let span = (p2.t - p1.t) == 0 ? 1 : (p2.t - p1.t)
    let u = clamp((t - p1.t) / span, 0, 1)
    return RMFocal(
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, u))
}
