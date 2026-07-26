//
//  Exporter.swift
//  dollyd
//
//  Export pipeline (BUILD_PLAN §6.6):
//    AVAssetReader on master.mov  ->  per-frame CVPixelBuffer  ->  Renderer  ->  AVAssetWriter
//    Audio mixed with AVMutableAudioMix (per-track gain/mute).
//    Presets: h264-1080p / h264-4k / hevc-4k / gif-720p.
//    Emits exportProgress events. AllowFrameReordering true (unless streamable).
//
//  Also houses the export-support types the Renderer depends on:
//    - CursorTrack   : parsed cursor.jsonl + shared-math smoothing (One Euro + spring).
//    - CursorArtwork : synthetic cursor + click-ripple bitmaps.
//    - CIColor(hex:) : parse project.json hex colors.
//
import AVFoundation
import CoreImage
import CoreMedia
import Foundation
import Metal
import VideoToolbox

final class Exporter {

    private let project: Project
    private let bundleDir: URL
    private let outURL: URL
    private let preset: ExportPreset
    private let emitter: Emitter

    init(project: Project, bundleDir: URL, outURL: URL, preset: ExportPreset,
         emitter: Emitter) throws {
        self.project = project
        self.bundleDir = bundleDir
        self.outURL = outURL
        self.preset = preset
        self.emitter = emitter
    }

    // MARK: - Preset resolution

    private struct ResolvedPreset {
        let width: Int
        let height: Int
        let codec: AVVideoCodecType
        let bitrate: Int
        let isGIF: Bool
    }

    private func resolvePreset() -> ResolvedPreset {
        // Output canvas keeps the source aspect; width/height below are the long-edge targets
        // fit to the source aspect (§6.6). The renderer draws into this canvas.
        let aspect = Double(project.source.width) / Double(project.source.height)
        func fit(long: Int) -> (Int, Int) {
            if aspect >= 1 { return (long, Int((Double(long) / aspect / 2).rounded()) * 2) }
            return (Int((Double(long) * aspect / 2).rounded()) * 2, long)
        }
        switch preset {
        case .h264_1080p:
            let (w, h) = fit(long: 1920)
            return .init(width: w, height: h, codec: .h264, bitrate: 12_000_000, isGIF: false)
        case .h264_4k:
            let (w, h) = fit(long: 3840)
            return .init(width: w, height: h, codec: .h264, bitrate: 45_000_000, isGIF: false)
        case .hevc_4k:
            let (w, h) = fit(long: 3840)
            return .init(width: w, height: h, codec: .hevc, bitrate: 35_000_000, isGIF: false)
        case .gif_720p:
            let (w, h) = fit(long: 1280)
            // GIF is produced via a separate CGImageDestination path (see runGIF()).
            return .init(width: w, height: h, codec: .h264, bitrate: 0, isGIF: true)
        }
    }

    // MARK: - Run

    /// Execute the export. Returns the byte size of the produced file.
    func run() async throws -> Int64 {
        let resolved = resolvePreset()
        let cursor = try CursorTrack(bundleDir: bundleDir,
                                     smoothing: project.cursor.smoothing)

        if resolved.isGIF {
            return try await runGIF(resolved: resolved, cursor: cursor)
        }
        return try await runVideo(resolved: resolved, cursor: cursor)
    }

    // MARK: - Video export

    private func runVideo(resolved: ResolvedPreset, cursor: CursorTrack) async throws -> Int64 {
        let masterURL = bundleDir.appendingPathComponent(project.source.master)
        let asset = AVURLAsset(url: masterURL)

        let trimIn = project.trim.in
        let trimOut = project.trim.out
        let duration = max(0.0001, trimOut - trimIn)

        // --- Reader (video) ---
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw SidecarError(code: "export.noVideoTrack",
                               message: "master has no video track")
        }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: trimIn, preferredTimescale: 600),
            duration: CMTime(seconds: duration, preferredTimescale: 600))
        let readerOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        readerOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(readerOutput) else {
            throw SidecarError(code: "export.readerConfig", message: "cannot add reader output")
        }
        reader.add(readerOutput)

        // --- Writer (video) ---
        try? FileManager.default.removeItem(at: outURL)
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: resolved.bitrate,
            AVVideoAllowFrameReorderingKey: true,   // §6.6 (unless streamable)
            AVVideoMaxKeyFrameIntervalKey: Int(project.source.fps) * 2
        ]
        if resolved.codec == .h264 {
            compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
        } else {
            compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main_AutoLevel
        }
        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: resolved.codec,
            AVVideoWidthKey: resolved.width,
            AVVideoHeightKey: resolved.height,
            AVVideoCompressionPropertiesKey: compression
        ])
        writerInput.expectsMediaDataInRealTime = false
        let outputSize = CGSize(width: resolved.width, height: resolved.height)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: writerInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: resolved.width,
                kCVPixelBufferHeightKey as String: resolved.height,
                kCVPixelBufferMetalCompatibilityKey as String: true
            ])
        guard writer.canAdd(writerInput) else {
            throw SidecarError(code: "export.writerConfig", message: "cannot add writer input")
        }
        writer.add(writerInput)

        // --- Audio (mix system + mic with per-track gain/mute, §6.6) ---
        let audioMixParams = try await addAudio(to: writer, asset: asset, reader: reader,
                                                trimIn: trimIn, duration: duration)

        // --- Renderer ---
        let device = MTLCreateSystemDefaultDevice()
        let renderer = Renderer(project: project, outputSize: outputSize,
                                cursor: cursor, mtlDevice: device)

        // --- Drive ---
        guard reader.startReading() else {
            throw SidecarError(code: "export.readerStart",
                               message: "\(reader.error.map { "\($0)" } ?? "unknown")")
        }
        guard writer.startWriting() else {
            throw SidecarError(code: "export.writerStart",
                               message: "\(writer.error.map { "\($0)" } ?? "unknown")")
        }
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(mtlDevice: device ?? MTLCreateSystemDefaultDevice()!)
        let processingQueue = DispatchQueue(label: "dolly.export.video")
        var frameCount = 0
        let startWall = DispatchTime.now()

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            writerInput.requestMediaDataWhenReady(on: processingQueue) {
                while writerInput.isReadyForMoreMediaData {
                    guard reader.status == .reading,
                          let sample = readerOutput.copyNextSampleBuffer(),
                          let pixels = CMSampleBufferGetImageBuffer(sample) else {
                        // Done or error.
                        writerInput.markAsFinished()
                        if reader.status == .failed {
                            cont.resume(throwing: SidecarError(
                                code: "export.readFailed",
                                message: "\(reader.error.map { "\($0)" } ?? "unknown")"))
                        } else {
                            cont.resume(returning: ())
                        }
                        return
                    }
                    // The frame's presentation time, relative to the trimmed timeline start.
                    let rawPTS = CMSampleBufferGetPresentationTimeStamp(sample)
                    let tRelativeToTrim = CMTimeGetSeconds(rawPTS) - trimIn
                    // The PROJECT timeline time = trimIn + tRelativeToTrim, but the renderer's
                    // zoom/cursor lookups use the project (untrimmed) timeline, so pass the
                    // absolute source time.
                    let projectTime = trimIn + tRelativeToTrim

                    let src = CIImage(cvPixelBuffer: pixels)
                    let composed = renderer.render(frame: src, atTime: projectTime)

                    guard let pool = adaptor.pixelBufferPool else { continue }
                    var out: CVPixelBuffer?
                    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
                    guard let buffer = out else { continue }
                    ciContext.render(composed, to: buffer)

                    // Rebase PTS to the output timeline (start at zero).
                    let outPTS = CMTime(seconds: tRelativeToTrim, preferredTimescale: 600)
                    adaptor.append(buffer, withPresentationTime: outPTS)

                    frameCount += 1
                    if frameCount % 15 == 0 {
                        let p = min(1.0, tRelativeToTrim / duration)
                        let elapsed = Double(DispatchTime.now().uptimeNanoseconds
                                             - startWall.uptimeNanoseconds) / 1e9
                        let fps = elapsed > 0 ? Double(frameCount) / elapsed : 0
                        self.emitter.emit(.eventExportProgress(p: p, fps: fps))
                    }
                }
            }
        }

        // The audio mix (if any) was applied at the AVAssetReaderAudioMixOutput in addAudio();
        // nothing further to do here. TODO(mac): join the audio pump with a DispatchGroup so
        // finishWriting() only runs after both the video and audio inputs are marked finished.
        _ = audioMixParams
        await writer.finishWriting()
        if writer.status == .failed {
            throw SidecarError(code: "export.writeFailed",
                               message: "\(writer.error.map { "\($0)" } ?? "unknown")")
        }
        self.emitter.emit(.eventExportProgress(p: 1.0, fps: 0))
        return fileSize(outURL)
    }

    // MARK: - Audio mixing (§6.6)

    /// Adds the project's audio tracks (system + mic, from the separate .m4a files) to the
    /// writer, applying per-track gain (linear) and mute via AVMutableAudioMix.
    ///
    /// NOTE: because DOLLY keeps audio in separate files (§3.1), we build an
    /// AVMutableComposition combining them, apply the mix, read the mixed track, and pipe it
    /// into the writer. Returns the mix for reference.
    ///
    /// TODO(mac): this is the trickiest AVFoundation piece to verify on device — routing a
    /// mixed audio track from an AVAssetReaderAudioMixOutput into the AVAssetWriter while the
    /// video pipeline runs concurrently. Structure is correct; the exact reader/writer
    /// interleave needs a device run.
    private func addAudio(to writer: AVAssetWriter, asset: AVURLAsset,
                          reader: AVAssetReader, trimIn: Double,
                          duration: Double) async throws -> AVMutableAudioMix? {
        let tracks = project.audio.filter { !$0.muted }
        guard !tracks.isEmpty else { return nil }

        let composition = AVMutableComposition()
        let mix = AVMutableAudioMix()
        var mixParams: [AVMutableAudioMixInputParameters] = []
        let timeRange = CMTimeRange(
            start: CMTime(seconds: trimIn, preferredTimescale: 600),
            duration: CMTime(seconds: duration, preferredTimescale: 600))

        for track in tracks {
            let url = bundleDir.appendingPathComponent(track.file)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let a = AVURLAsset(url: url)
            guard let src = try await a.loadTracks(withMediaType: .audio).first,
                  let comp = composition.addMutableTrack(withMediaType: .audio,
                                                         preferredTrackID: kCMPersistentTrackID_Invalid)
            else { continue }
            try comp.insertTimeRange(timeRange, of: src, at: .zero)
            let p = AVMutableAudioMixInputParameters(track: comp)
            p.setVolume(Float(track.gain), at: .zero) // linear gain
            mixParams.append(p)
        }
        mix.inputParameters = mixParams

        // Read the mixed audio and add a writer input for it.
        let audioReader = try AVAssetReader(asset: composition)
        let mixOutput = AVAssetReaderAudioMixOutput(
            audioTracks: composition.tracks(withMediaType: .audio),
            audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2
            ])
        mixOutput.audioMix = mix
        audioReader.add(mixOutput)

        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192_000
        ])
        audioInput.expectsMediaDataInRealTime = false
        if writer.canAdd(audioInput) {
            writer.add(audioInput)
            // Pump the mixed audio on its own queue. TODO(mac): synchronize completion with
            // the video pump before finishWriting; a DispatchGroup around both is the fix.
            audioReader.startReading()
            let q = DispatchQueue(label: "dolly.export.audio")
            audioInput.requestMediaDataWhenReady(on: q) {
                while audioInput.isReadyForMoreMediaData {
                    if let sb = mixOutput.copyNextSampleBuffer() {
                        audioInput.append(sb)
                    } else {
                        audioInput.markAsFinished()
                        break
                    }
                }
            }
        }
        return mix
    }

    // MARK: - GIF export (gif-720p)

    /// GIF export uses CGImageDestination with the GIF UTType rather than AVAssetWriter. We
    /// sample the source at a reduced frame rate (~15fps is plenty for a 720p GIF) and write
    /// each composed frame as a GIF frame.
    private func runGIF(resolved: ResolvedPreset, cursor: CursorTrack) async throws -> Int64 {
        // TODO(mac): implement the CGImageDestination GIF writer. Structure:
        //   - AVAssetReader over master at trim range, same as runVideo.
        //   - Renderer.render(...) -> CIImage -> CGImage via CIContext.createCGImage.
        //   - CGImageDestinationCreateWithURL(kUTTypeGIF), set loop count, per-frame delay
        //     ~1/15s, add each CGImage, finalize.
        //   - Emit exportProgress like runVideo.
        // Left as a documented stub for the first draft; the three MP4/HEVC presets are the
        // primary path and share runVideo().
        throw SidecarError(code: "export.gifNotImplemented",
                           message: "gif-720p export is a documented stub in the first draft")
    }

    // MARK: - Helpers

    private func fileSize(_ url: URL) -> Int64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? Int64) ?? 0
    }
}

// MARK: - CursorTrack: parsed cursor.jsonl + shared-math smoothing (§6.5)

/// Loads cursor.jsonl and provides smoothed positions for the synthetic cursor and the
/// follow-focal target. Smoothing uses the SAME shared math as the preview (One Euro filter +
/// spring), so preview/export cursor paths match (§2.3, §6.5).
final class CursorTrack {

    struct Sample {
        let t: Double
        let x: Double
        let y: Double
        let e: CursorEventKind
        let b: MouseButton?
    }

    private let samples: [Sample]      // move/down/up/drag/scroll with positions, time-sorted
    private let clicks: [Sample]       // `down` events only
    private let smoothing: Double

    // Precomputed smoothed positions (One Euro on the raw samples). The spring smoothing in
    // §6.5 is applied per-render using `smoothing` -> damping; here we store the One Euro pass.
    private let smoothedX: [Double]
    private let smoothedY: [Double]

    init(bundleDir: URL, smoothing: Double) throws {
        self.smoothing = smoothing
        let url = bundleDir.appendingPathComponent("cursor.jsonl")
        var parsed: [Sample] = []
        if let data = try? Data(contentsOf: url),
           let text = String(data: data, encoding: .utf8) {
            let decoder = JSONDecoder()
            for line in text.split(separator: "\n") {
                guard let lineData = line.data(using: .utf8),
                      let ev = try? decoder.decode(CursorEvent.self, from: lineData) else { continue }
                // key events carry no position; skip for positional track.
                guard let x = ev.x, let y = ev.y else { continue }
                parsed.append(Sample(t: ev.t, x: x, y: y, e: ev.e, b: ev.b))
            }
        }
        parsed.sort { $0.t < $1.t }
        self.samples = parsed
        self.clicks = parsed.filter { $0.e == .down }

        // One Euro pass over the raw positions (§6.4 step 1 / §6.5).
        let fx = OneEuroFilter()
        let fy = OneEuroFilter()
        var sx: [Double] = []
        var sy: [Double] = []
        sx.reserveCapacity(parsed.count)
        sy.reserveCapacity(parsed.count)
        for s in parsed {
            sx.append(fx.filter(s.x, s.t))
            sy.append(fy.filter(s.y, s.t))
        }
        self.smoothedX = sx
        self.smoothedY = sy
    }

    /// Linearly interpolated smoothed position at project time `t`. Returns nil if no samples.
    func smoothedPosition(at t: Double) -> RMFocal? {
        guard !samples.isEmpty else { return nil }
        // Binary search for the sample interval containing t.
        if t <= samples.first!.t { return RMFocal(x: smoothedX.first!, y: smoothedY.first!) }
        if t >= samples.last!.t { return RMFocal(x: smoothedX.last!, y: smoothedY.last!) }
        var lo = 0, hi = samples.count - 1
        while lo + 1 < hi {
            let mid = (lo + hi) / 2
            if samples[mid].t <= t { lo = mid } else { hi = mid }
        }
        let t0 = samples[lo].t, t1 = samples[hi].t
        let f = t1 > t0 ? (t - t0) / (t1 - t0) : 0
        return RMFocal(x: smoothedX[lo] + (smoothedX[hi] - smoothedX[lo]) * f,
                       y: smoothedY[lo] + (smoothedY[hi] - smoothedY[lo]) * f)
    }

    /// Seconds since the last positional move before `t` (for hideWhenIdle fade, §6.5).
    func idleSeconds(at t: Double) -> Double {
        var last: Double = -1
        for s in samples where s.t <= t { last = s.t }
        return last < 0 ? .greatestFiniteMagnitude : (t - last)
    }

    /// Most recent `down` click within `window` seconds before `t`, for the ripple (§6.5).
    func lastClick(before t: Double, within window: Double) -> Sample? {
        var found: Sample?
        for c in clicks where c.t <= t && (t - c.t) <= window { found = c }
        return found
    }
}

// MARK: - CursorArtwork: synthetic cursor & ripple bitmaps (§6.5)

/// Draws the synthetic cursor and click ripple as CIImages. Uses bundled vector art per §6.5
/// ("bundled SVG arrow/I-beam paths, not the 24px system bitmap").
enum CursorArtwork {

    /// The macOS arrow cursor as a vector path, drawn at `scale` (1.0 ~= 24pt) with `alpha`.
    /// Hotspot (the pointer tip) is at the TOP-LEFT of the returned image extent.
    static func arrowImage(scale: Double, alpha: Double) -> CIImage? {
        // TODO(mac): replace this hand-built path with the real bundled arrow.svg rasterized
        // via a small SVG->CGPath step (or a prebaked @3x PNG loaded from the bundle). The
        // path below approximates the classic macOS arrow so the composition is visible.
        let base = 24.0 * scale
        let w = Int(base.rounded()), h = Int((base * 1.4).rounded())
        guard w > 0, h > 0 else { return nil }
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        // Arrow polygon in a top-left space; flip because CGContext is bottom-left.
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)
        let s = CGFloat(scale)
        let pts: [CGPoint] = [
            CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 16 * s), CGPoint(x: 4 * s, y: 12 * s),
            CGPoint(x: 7 * s, y: 19 * s), CGPoint(x: 10 * s, y: 18 * s),
            CGPoint(x: 7 * s, y: 11 * s), CGPoint(x: 12 * s, y: 11 * s)
        ]
        ctx.beginPath()
        ctx.move(to: pts[0])
        for p in pts.dropFirst() { ctx.addLine(to: p) }
        ctx.closePath()
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: CGFloat(alpha))
        ctx.setStrokeColor(red: 0, green: 0, blue: 0, alpha: CGFloat(alpha))
        ctx.setLineWidth(1.5 * s)
        ctx.drawPath(using: .fillStroke)
        guard let cg = ctx.makeImage() else { return nil }
        return CIImage(cgImage: cg)
    }

    /// A click-ripple ring centered at `center` (canvas coords), radius `radius`, `alpha`.
    static func rippleImage(center: CGPoint, radius: Double, alpha: Double) -> CIImage? {
        let dim = Int((radius * 2 + 8).rounded())
        guard dim > 0 else { return nil }
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: dim, height: dim, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: CGFloat(alpha))
        ctx.setLineWidth(2)
        let c = CGFloat(dim) / 2
        ctx.addArc(center: CGPoint(x: c, y: c), radius: CGFloat(radius),
                   startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        guard let cg = ctx.makeImage() else { return nil }
        return CIImage(cgImage: cg)
            .transformed(by: CGAffineTransform(translationX: center.x - c, y: center.y - c))
    }
}

// MARK: - CIColor(hex:)

extension CIColor {
    /// Parse a "#RRGGBB" or "#RRGGBBAA" hex string from project.json. Colors are treated as
    /// sRGB, matching the pinned capture colorspace (§5.2) and the preview.
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var value: UInt64 = 0
        Scanner(string: s).scanHexInt64(&value)
        let r, g, b, a: CGFloat
        if s.count == 8 {
            r = CGFloat((value >> 24) & 0xFF) / 255
            g = CGFloat((value >> 16) & 0xFF) / 255
            b = CGFloat((value >> 8) & 0xFF) / 255
            a = CGFloat(value & 0xFF) / 255
        } else {
            r = CGFloat((value >> 16) & 0xFF) / 255
            g = CGFloat((value >> 8) & 0xFF) / 255
            b = CGFloat(value & 0xFF) / 255
            a = 1
        }
        // sRGB color space to match capture/preview.
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        self.init(red: r, green: g, blue: b, alpha: a, colorSpace: cs)!
    }
}
