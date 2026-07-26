//
//  Writers.swift
//  dollyd
//
//  Dual-write video writers (BUILD_PLAN §2.4, §5.5).
//
//  Capture ALWAYS writes two video files simultaneously:
//    - master: ProRes 422 LT (studio) or H.264 all-intra (quick) — the export source.
//    - proxy:  H.264, 1280px wide, GOP 15, ~4Mbps — editor playback / scrubbing.
//
//  Backpressure rule (§5.5): if an input's `isReadyForMoreMediaData` is false, drop the
//  PROXY frame — NEVER the master — and increment a counter surfaced in the `recording`
//  event. The master must be complete; the proxy is regenerable-ish and disposable per frame.
//
//  Proxy downscale reuses a single CVPixelBufferPool and a CIContext (§5.5). Master frames
//  are appended straight from the SCStream sample buffers (no re-encode of pixels beyond what
//  the AVAssetWriter codec does).
//
import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Owns both AVAssetWriters and the proxy scaling pipeline. One instance per recording.
final class VideoWriters {

    struct Config {
        let quality: Quality
        let width: Int          // master pixel width (backing scale applied, §5.2)
        let height: Int         // master pixel height
        let fps: Int
        let masterURL: URL
        let proxyURL: URL
    }

    private let config: Config

    // Master
    private let masterWriter: AVAssetWriter
    private let masterInput: AVAssetWriterInput

    // Proxy
    private let proxyWriter: AVAssetWriter
    private let proxyInput: AVAssetWriterInput
    private let proxyAdaptor: AVAssetWriterInputPixelBufferAdaptor
    private let proxyWidth: Int
    private let proxyHeight: Int

    // Proxy scaling
    private let ciContext: CIContext
    private var proxyPool: CVPixelBufferPool?

    // Session / clock
    private var started = false
    private var sessionStartPTS: CMTime = .invalid

    // Backpressure counter (surfaced in `recording` events).
    private(set) var droppedProxyFrames: Int = 0

    // Serialize appends; SCStream delivers on its own queue but we keep writer access serial.
    private let queue = DispatchQueue(label: "dolly.writers")

    init(config: Config) throws {
        self.config = config

        // --- Master writer ---
        masterWriter = try AVAssetWriter(outputURL: config.masterURL,
                                         fileType: config.quality == .studio ? .mov : .mp4)
        let masterSettings = VideoWriters.masterSettings(config)
        masterInput = AVAssetWriterInput(mediaType: .video, outputSettings: masterSettings)
        masterInput.expectsMediaDataInRealTime = true
        guard masterWriter.canAdd(masterInput) else {
            throw SidecarError(code: "capture.writerConfig",
                               message: "master writer rejected input settings")
        }
        masterWriter.add(masterInput)

        // --- Proxy writer (1280px wide, preserve aspect) ---
        let scale = 1280.0 / Double(config.width)
        proxyWidth = 1280
        // Keep even height for H.264.
        proxyHeight = Int((Double(config.height) * scale / 2.0).rounded()) * 2
        proxyWriter = try AVAssetWriter(outputURL: config.proxyURL, fileType: .mp4)
        let proxySettings = VideoWriters.proxySettings(width: proxyWidth, height: proxyHeight)
        proxyInput = AVAssetWriterInput(mediaType: .video, outputSettings: proxySettings)
        proxyInput.expectsMediaDataInRealTime = true
        proxyAdaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: proxyInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: proxyWidth,
                kCVPixelBufferHeightKey as String: proxyHeight,
                kCVPixelBufferMetalCompatibilityKey as String: true
            ])
        guard proxyWriter.canAdd(proxyInput) else {
            throw SidecarError(code: "capture.writerConfig",
                               message: "proxy writer rejected input settings")
        }
        proxyWriter.add(proxyInput)

        // CIContext for downscale. Use the default Metal device.
        // TODO(mac): if Core Image downscale can't keep up at 4K60, swap to a vImage scale
        // (vImageScale_ARGB8888) as §5.5 lists as the alternative. CIContext is simpler and
        // usually sufficient because the proxy is small.
        if let device = MTLCreateSystemDefaultDevice() {
            ciContext = CIContext(mtlDevice: device)
        } else {
            ciContext = CIContext(options: [.useSoftwareRenderer: false])
        }
    }

    // MARK: - Codec settings

    private static func masterSettings(_ config: Config) -> [String: Any] {
        switch config.quality {
        case .studio:
            // ProRes 422 LT — no bitrate key; ProRes is CBR-ish by profile.
            return [
                AVVideoCodecKey: AVVideoCodecType.proRes422LT,
                AVVideoWidthKey: config.width,
                AVVideoHeightKey: config.height,
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
                ]
            ]
        case .quick:
            // H.264 all-intra: keyframe every frame (§2.4 "1-second GOP" is the looser Quick
            // master variant; §5.5 says all-intra — we honor the stricter §5.5 wording with
            // MaxKeyFrameInterval = 1). TODO(mac): confirm this is the intended Quick master.
            return [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: config.width,
                AVVideoHeightKey: config.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    AVVideoMaxKeyFrameIntervalKey: 1,
                    AVVideoAllowFrameReorderingKey: false
                ]
            ]
        }
    }

    private static func proxySettings(width: Int, height: Int) -> [String: Any] {
        return [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAverageBitRateKey: 4_000_000,        // ~4 Mbps (§5.5)
                AVVideoMaxKeyFrameIntervalKey: 15,          // GOP 15 (§2.4, §5.5)
                AVVideoAllowFrameReorderingKey: true
            ]
        ]
    }

    // MARK: - Lifecycle

    /// Begin both writer sessions anchored at the first sample's PTS. Called once, on the
    /// first video sample, before the first append.
    private func startIfNeeded(at pts: CMTime) {
        guard !started else { return }
        started = true
        sessionStartPTS = pts
        masterWriter.startWriting()
        masterWriter.startSession(atSourceTime: pts)
        proxyWriter.startWriting()
        proxyWriter.startSession(atSourceTime: pts)
    }

    /// Append one video sample buffer to both writers. Returns whether the MASTER frame was
    /// committed (so ClockSync can set t0 on the first committed master frame — §5.3).
    ///
    /// Must be called for each SCStream `.screen` sample buffer, in order.
    @discardableResult
    func append(sampleBuffer: CMSampleBuffer) -> Bool {
        var masterCommitted = false
        queue.sync {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            startIfNeeded(at: pts)

            // --- MASTER: never drop. If not ready, we still must not lose it; in practice a
            // real-time input rarely stalls, but if it does we log. §5.5: never drop master.
            if masterInput.isReadyForMoreMediaData {
                if masterInput.append(sampleBuffer) {
                    masterCommitted = true
                } else {
                    log("master append failed:", masterWriter.error as Any)
                }
            } else {
                // Backpressure on MASTER is a problem — surface but do not drop silently.
                // TODO(mac): consider a small bounded queue for master to ride out stalls.
                log("WARNING master input not ready; frame at", CMTimeGetSeconds(pts),
                    "may be lost")
            }

            // --- PROXY: droppable (§5.5). If not ready, drop & count.
            if proxyInput.isReadyForMoreMediaData {
                appendProxy(from: sampleBuffer, pts: pts)
            } else {
                droppedProxyFrames += 1
            }
        }
        return masterCommitted
    }

    private func appendProxy(from sampleBuffer: CMSampleBuffer, pts: CMTime) {
        guard let srcPixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Lazily create the pool once we know the writer is set up.
        if proxyPool == nil {
            var pool: CVPixelBufferPool?
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: proxyWidth,
                kCVPixelBufferHeightKey as String: proxyHeight,
                kCVPixelBufferMetalCompatibilityKey as String: true,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary
            ]
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
            proxyPool = pool
        }
        guard let pool = proxyPool else { droppedProxyFrames += 1; return }

        var dst: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &dst) == kCVReturnSuccess,
              let out = dst else {
            droppedProxyFrames += 1
            return
        }

        // Downscale via CIContext into the reused buffer.
        let srcImage = CIImage(cvPixelBuffer: srcPixels)
        let sx = Double(proxyWidth) / Double(CVPixelBufferGetWidth(srcPixels))
        let sy = Double(proxyHeight) / Double(CVPixelBufferGetHeight(srcPixels))
        let scaled = srcImage.transformed(by: CGAffineTransform(scaleX: CGFloat(sx),
                                                                y: CGFloat(sy)))
        ciContext.render(scaled, to: out)

        if !proxyAdaptor.append(out, withPresentationTime: pts) {
            droppedProxyFrames += 1
            log("proxy adaptor append failed:", proxyWriter.error as Any)
        }
    }

    /// Finish both files. Returns when both writers have flushed to disk.
    func finish() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async {
                self.masterInput.markAsFinished()
                self.proxyInput.markAsFinished()
                let group = DispatchGroup()
                group.enter()
                self.masterWriter.finishWriting { group.leave() }
                group.enter()
                self.proxyWriter.finishWriting { group.leave() }
                group.notify(queue: self.queue) { cont.resume() }
            }
        }
    }
}

// MARK: - Disk pre-flight (§5.5)

enum DiskPreflight {
    /// Refuse to start if the target volume has < 10GB free (§5.5). ProRes 422 LT 4K60 is
    /// ~1.5–2 GB/min, so anything less is a footgun.
    static let minimumFreeBytes: Int64 = 10 * 1024 * 1024 * 1024

    /// Throws SidecarError("disk.insufficientSpace") if the volume backing `url` is too full.
    static func check(outputURL url: URL) throws {
        let dir = url.deletingLastPathComponent()
        let values = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        // volumeAvailableCapacityForImportantUsageKey is the modern, accurate free-space key.
        if let free = values?.volumeAvailableCapacityForImportantUsage {
            if free < minimumFreeBytes {
                throw SidecarError(code: "disk.insufficientSpace",
                    message: "need >= 10GB free, have \(free / (1024*1024*1024))GB")
            }
        } else {
            // TODO(mac): fall back to statfs if the resource key is unavailable on the volume.
            log("could not read free space for", dir.path, "- skipping pre-flight")
        }
    }
}
