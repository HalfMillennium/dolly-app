//
//  SCRecorder.swift
//  dollyd
//
//  ScreenCaptureKit stream orchestration (BUILD_PLAN §5.1–§5.2, §5.5).
//
//  Responsibilities:
//    - Source enumeration (§5.1): SCShareableContent, filter <80x80 windows and our own,
//      build thumbnails.
//    - Stream configuration (§5.2): showsCursor=false (§2.5 synthetic cursor), pinned sRGB,
//      32BGRA, 1/60 min frame interval, queueDepth 8, capturesAudio, excludesCurrentProcess.
//    - Region capture via sourceRect.
//    - Drive the writers (video dual-write + audio) and the event monitor.
//    - Establish the clock origin (§5.3) on the first COMMITTED master frame.
//    - Handle stream(_:didStopWithError:) (§5.2).
//
import AVFoundation
import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

/// Result of a completed recording, returned to the `stop` responder.
struct RecordingResult {
    let bundlePath: String
    let duration: Double
    let droppedProxyFrames: Int
}

final class SCRecorder: NSObject, SCStreamDelegate, SCStreamOutput {

    // MARK: Source enumeration (§5.1)

    /// Enumerate displays and windows. Filters windows < 80x80 and windows owned by DOLLY,
    /// and attaches a base64 JPEG thumbnail per window (§5.1).
    static func enumerateSources() async throws -> (displays: [DisplayInfo], windows: [WindowInfo]) {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
        } catch {
            // The canonical failure here is Screen Recording permission not granted.
            // TODO(mac): map the specific error/domain to tcc.screenRecording.denied. The
            // thrown error is typically an SCStreamError; inspect .code on device.
            throw SidecarError(code: "tcc.screenRecording.denied",
                               message: "cannot read shareable content: \(error)")
        }

        let displays: [DisplayInfo] = content.displays.map { d in
            // NSScreen backingScaleFactor for the matching display gives the scale.
            let scale = SCRecorder.backingScale(forDisplayID: d.displayID)
            return DisplayInfo(id: Int(d.displayID),
                               width: d.width, height: d.height,
                               scale: scale,
                               name: "Display \(d.displayID)")
        }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        var windows: [WindowInfo] = []
        for w in content.windows {
            let f = w.frame
            if f.width < 80 || f.height < 80 { continue }              // §5.1 filter
            if w.owningApplication?.processID == ownPID { continue }    // exclude own windows
            let app = w.owningApplication?.applicationName ?? "Unknown"
            let thumb = await SCRecorder.thumbnail(for: w)
            windows.append(WindowInfo(
                id: Int(w.windowID),
                app: app,
                title: w.title ?? "",
                frame: RectValue(x: Double(f.origin.x), y: Double(f.origin.y),
                                 w: Double(f.width), h: Double(f.height)),
                thumb: thumb))
        }
        return (displays, windows)
    }

    private static func backingScale(forDisplayID id: CGDirectDisplayID) -> Double {
        for screen in NSScreen.screens {
            if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
               num.uint32Value == id {
                return Double(screen.backingScaleFactor)
            }
        }
        return 2.0 // sensible default for Retina
    }

    /// Small JPEG thumbnail for a window, returned as a data: URI (§5.1).
    private static func thumbnail(for window: SCWindow) async -> String? {
        let cfg = SCStreamConfiguration()
        cfg.width = 320
        cfg.height = max(1, Int(320.0 * window.frame.height / max(1, window.frame.width)))
        cfg.showsCursor = false
        let filter = SCContentFilter(desktopIndependentWindow: window)
        do {
            // SCScreenshotManager is the modern single-frame API (macOS 14+).
            // TODO(mac): if targeting 13, fall back to capturing one frame from a short-lived
            // SCStream. On 14+ this is the clean path.
            let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter,
                                                                     configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: cgImage)
            guard let data = rep.representation(using: .jpeg,
                                                properties: [.compressionFactor: 0.6]) else {
                return nil
            }
            return "data:image/jpeg;base64," + data.base64EncodedString()
        } catch {
            log("thumbnail capture failed for window", window.windowID, ":", error)
            return nil
        }
    }

    // MARK: Instance state

    private let request: ReqStart
    private let emitter: Emitter
    private let bundleURL: URL

    private var stream: SCStream?
    private var writers: VideoWriters?
    private var audio: AudioTap?
    private var eventMonitor: EventMonitor?
    private let clock = ClockSync()

    // Queues for SCStream output callbacks.
    private let videoQueue = DispatchQueue(label: "dolly.sc.video")
    private let audioQueue = DispatchQueue(label: "dolly.sc.audio")

    // Session timing / `recording` event throttle.
    private var lastRecordingEventTime: Double = -1
    private var firstFramePTS: CMTime = .invalid
    private var lastFramePTS: CMTime = .invalid

    private var stopContinuation: CheckedContinuation<RecordingResult, Error>?
    private var stopped = false

    init(request: ReqStart, emitter: Emitter) throws {
        self.request = request
        self.emitter = emitter
        self.bundleURL = URL(fileURLWithPath: request.out, isDirectory: true)
        super.init()

        // Create the .dolly bundle directory.
        try FileManager.default.createDirectory(at: bundleURL,
                                                 withIntermediateDirectories: true)
        // Disk pre-flight (§5.5).
        try DiskPreflight.check(outputURL: bundleURL)
    }

    // MARK: Start (§5.2)

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)

        let (filter, pixelWidth, pixelHeight, scale, mapping) =
            try buildFilterAndConfig(from: content)

        // --- Stream configuration (§5.2) ---
        let cfg = SCStreamConfiguration()
        cfg.width = pixelWidth      // backing scale already applied (§5.2)
        cfg.height = pixelHeight
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60) // 60fps cap
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false     // §2.5: synthetic cursor, captured pixels have no cursor
        cfg.queueDepth = 8
        cfg.capturesAudio = request.systemAudio
        cfg.excludesCurrentProcessAudio = true
        // Pin sRGB explicitly — P3 without pinning desaturates (§5.2).
        cfg.colorSpaceName = CGColorSpace.sRGB
        // Region capture: sourceRect (§5.1). For display/window it stays .zero (full surface).
        if case let .region(_, rect) = request.target {
            cfg.sourceRect = CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h)
        }

        // --- Writers (§5.5) ---
        let fps = 60
        let quality = request.quality
        let masterName = quality == .studio ? "master.mov" : "master.mp4"
        let writers = try VideoWriters(config: .init(
            quality: quality,
            width: pixelWidth, height: pixelHeight, fps: fps,
            masterURL: bundleURL.appendingPathComponent(masterName),
            proxyURL: bundleURL.appendingPathComponent("proxy.mp4")))
        self.writers = writers

        // --- Audio (§5.5) ---
        let audio = try AudioTap(
            systemAudioURL: request.systemAudio
                ? bundleURL.appendingPathComponent("audio-system.m4a") : nil,
            micDeviceUID: request.mic,
            micURL: request.mic != nil
                ? bundleURL.appendingPathComponent("audio-mic.m4a") : nil)
        self.audio = audio

        // --- Event monitor (§5.4). Must be created on the main thread run loop. ---
        let detectTyping = request.detectTyping ?? false
        let monitor = try EventMonitor(clock: clock, mapping: mapping,
                                       detectTyping: detectTyping,
                                       cursorFileURL: bundleURL.appendingPathComponent("cursor.jsonl"))
        self.eventMonitor = monitor

        // --- Build the stream and add outputs ---
        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if request.systemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        }
        self.stream = stream

        // Store the scale into the .scale we'll write to project.json on stop.
        self.captureScale = scale

        // Start audio capture session, install monitors on the main thread, start stream.
        audio.start()
        await MainActor.run { monitor.start() }
        try await stream.startCapture()
        // Persist a project.json skeleton so the editor can open partial recordings; it is
        // rewritten on stop with the final duration.
        writeProjectSkeleton(width: pixelWidth, height: pixelHeight, scale: scale, fps: fps,
                             masterName: masterName)
        log("capture started ->", bundleURL.path)
    }

    private var captureScale: Double = 2.0

    /// Build the SCContentFilter and derive pixel dimensions + the AppKit->normalized mapping
    /// for the requested target (§5.1, §5.2).
    private func buildFilterAndConfig(from content: SCShareableContent)
        throws -> (SCContentFilter, Int, Int, Double, SurfaceMapping) {

        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0

        switch request.target {
        case let .display(id):
            guard let display = content.displays.first(where: { $0.displayID == CGDirectDisplayID(id) }) else {
                throw SidecarError(code: "capture.displayNotFound",
                                   message: "display \(id) not found")
            }
            let scale = SCRecorder.backingScale(forDisplayID: display.displayID)
            // Exclude our own windows from the display capture.
            let ownWindows = content.windows.filter {
                $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier
            }
            let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            let pw = Int(Double(display.width) * scale)
            let ph = Int(Double(display.height) * scale)
            // Display frame in global AppKit coords.
            let frame = SCRecorder.displayFrameGlobal(display.displayID)
            let mapping = SurfaceMapping(captureRectGlobalBL: frame,
                                         primaryDisplayHeight: primaryHeight)
            return (filter, pw, ph, scale, mapping)

        case let .window(id):
            guard let window = content.windows.first(where: { $0.windowID == CGWindowID(id) }) else {
                throw SidecarError(code: "capture.windowNotFound",
                                   message: "window \(id) not found")
            }
            let scale = SCRecorder.backingScale(forDisplayID: CGMainDisplayID())
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let pw = Int(Double(window.frame.width) * scale)
            let ph = Int(Double(window.frame.height) * scale)
            // SCWindow.frame is in global coordinates but TOP-LEFT origin (CoreGraphics
            // display space). Convert to AppKit bottom-left for the mapping.
            // TODO(mac): verify SCWindow.frame origin convention on device; docs say it is in
            // points of the global display coordinate space (top-left). We flip Y here.
            let flippedY = primaryHeight - window.frame.origin.y - window.frame.height
            let frameBL = CGRect(x: window.frame.origin.x, y: flippedY,
                                 width: window.frame.width, height: window.frame.height)
            let mapping = SurfaceMapping(captureRectGlobalBL: frameBL,
                                         primaryDisplayHeight: primaryHeight)
            return (filter, pw, ph, scale, mapping)

        case let .region(displayID, rect):
            guard let display = content.displays.first(where: { $0.displayID == CGDirectDisplayID(displayID) }) else {
                throw SidecarError(code: "capture.displayNotFound",
                                   message: "display \(displayID) not found")
            }
            let scale = SCRecorder.backingScale(forDisplayID: display.displayID)
            let ownWindows = content.windows.filter {
                $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier
            }
            let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            // sourceRect is set by the caller in start(); pixel dims are the region * scale.
            let pw = Int(rect.w * scale)
            let ph = Int(rect.h * scale)
            // The region rect is in display-local top-left points; map to global bottom-left.
            let displayFrame = SCRecorder.displayFrameGlobal(display.displayID)
            let regionBL = CGRect(x: displayFrame.minX + rect.x,
                                  y: displayFrame.maxY - rect.y - rect.h,
                                  width: rect.w, height: rect.h)
            let mapping = SurfaceMapping(captureRectGlobalBL: regionBL,
                                         primaryDisplayHeight: primaryHeight)
            return (filter, pw, ph, scale, mapping)
        }
    }

    /// A display's frame in global AppKit (bottom-left) coordinates.
    private static func displayFrameGlobal(_ id: CGDirectDisplayID) -> CGRect {
        for screen in NSScreen.screens {
            if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
               num.uint32Value == id {
                return screen.frame
            }
        }
        // Fallback: CoreGraphics bounds (top-left) — good enough if NSScreen lookup fails.
        return CGDisplayBounds(id)
    }

    // MARK: SCStreamOutput (frame/audio delivery)

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        switch type {
        case .screen:
            handleVideo(sampleBuffer)
        case .audio:
            audio?.appendSystemAudio(sampleBuffer)
        default:
            break
        }
    }

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        // SCStream marks frames with a status attachment; skip non-`.complete` frames (e.g.
        // `.idle` when nothing changed) so we don't write duplicate/blank frames.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let statusRaw = attachments.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: statusRaw),
           status != .complete {
            return
        }

        guard let writers = writers else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstFramePTS == .invalid { firstFramePTS = pts }
        lastFramePTS = pts

        // Dual-write. The MASTER commit is what defines the clock origin (§5.3): only set t0
        // once a frame is actually committed to the master writer.
        let masterCommitted = writers.append(sampleBuffer: sampleBuffer)
        if masterCommitted {
            clock.markFirstCommittedFrame(sampleBuffer) // idempotent; only first call sticks
        }

        // Emit a throttled `recording` event (~4Hz) with the current relative time and the
        // running dropped-proxy counter (§5.5).
        if let t = clock.relativeTime(forHostSeconds: CMTimeGetSeconds(pts)) {
            if t - lastRecordingEventTime >= 0.25 {
                lastRecordingEventTime = t
                emitter.emit(.eventRecording(t: t, dropped: writers.droppedProxyFrames))
            }
        }
    }

    // MARK: SCStreamDelegate (§5.2)

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Display reconfiguration, target window closing, display sleep (§5.2). On window loss
        // we stop cleanly and KEEP the footage.
        log("stream stopped with error:", error)
        emitter.emit(.eventError(code: "capture.streamStopped", message: "\(error)"))
        // Finalize whatever we have; resume any pending stop continuation.
        Task { await finalizeAndResume() }
    }

    // MARK: Stop (§5.2)

    func stop() async throws -> RecordingResult {
        return try await withCheckedContinuation { (cont: CheckedContinuation<RecordingResult, Error>) in
            self.stopContinuation = cont
            Task {
                do {
                    try await self.stream?.stopCapture()
                } catch {
                    log("stopCapture error (continuing to finalize):", error)
                }
                await self.finalizeAndResume()
            }
        }
    }

    private func finalizeAndResume() async {
        guard !stopped else { return }
        stopped = true

        await MainActor.run { eventMonitor?.stop() }
        await writers?.finish()
        await audio?.finish()

        let duration: Double
        if firstFramePTS != .invalid && lastFramePTS != .invalid {
            duration = CMTimeGetSeconds(lastFramePTS) - CMTimeGetSeconds(firstFramePTS)
        } else {
            duration = 0
        }

        // Rewrite project.json with the final duration.
        rewriteProjectDuration(duration)

        let result = RecordingResult(bundlePath: bundleURL.path,
                                     duration: duration,
                                     droppedProxyFrames: writers?.droppedProxyFrames ?? 0)
        stopContinuation?.resume(returning: result)
        stopContinuation = nil
    }

    // MARK: project.json bootstrap

    /// Write a minimal, schema-valid project.json so the editor can open the bundle. Duration
    /// is filled on stop (§3.3). Defaults mirror the §3.3 example.
    private func writeProjectSkeleton(width: Int, height: Int, scale: Double, fps: Int,
                                      masterName: String) {
        var audioTracks: [AudioTrack] = []
        if request.systemAudio {
            audioTracks.append(AudioTrack(file: "audio-system.m4a", role: .system,
                                          gain: 1.0, muted: false))
        }
        if request.mic != nil {
            audioTracks.append(AudioTrack(file: "audio-mic.m4a", role: .mic,
                                          gain: 1.0, muted: false))
        }
        let project = Project(
            version: 1,
            source: Source(master: masterName, proxy: "proxy.mp4",
                           width: width, height: height, fps: Double(fps),
                           duration: 0, scale: scale),
            audio: audioTracks,
            trim: Trim(in: 0, out: 0),
            composition: Composition(
                backdrop: .gradient(from: "#2A3138", to: "#151A1F", angle: 135),
                padding: 0.06, radius: 12,
                shadow: Shadow(enabled: true, opacity: 0.45, blur: 48, y: 14)),
            cursor: CursorStyle(visible: true, size: 1.0, smoothing: 0.35,
                                clickRipple: true, hideWhenIdle: 2.0),
            zooms: [], speed: [], autoZoom: nil)
        writeProject(project)
    }

    private func rewriteProjectDuration(_ duration: Double) {
        let url = bundleURL.appendingPathComponent("project.json")
        guard let data = try? Data(contentsOf: url),
              var project = try? JSONDecoder().decode(Project.self, from: data) else { return }
        project.source.duration = duration
        project.trim = Trim(in: 0, out: duration)
        writeProject(project)
    }

    private func writeProject(_ project: Project) {
        let url = bundleURL.appendingPathComponent("project.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        do {
            let data = try encoder.encode(project)
            try data.write(to: url)
        } catch {
            log("failed to write project.json:", error)
        }
    }
}
