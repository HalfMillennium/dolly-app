//
//  EventMonitor.swift
//  dollyd
//
//  Cursor / input telemetry (BUILD_PLAN §5.4, §3.2).
//
//  - Uses NSEvent monitors, NOT CGEventTap (§5.4). Installs BOTH a global monitor (events
//    delivered to OTHER apps — the normal case while recording another app) AND a local
//    monitor (events delivered to us — e.g. our own overlay window during region drag).
//  - Watches mouse move / down / up / drag / right-down / scroll, and OPTIONALLY key events
//    for TIMING ONLY (no keycodes, ever — §3.2 "not a keylogger"). Key telemetry is opt-in
//    (`detectTyping`) and needs Input Monitoring (§5.4).
//  - Timestamps come from ClockSync (NSEvent.timestamp -> session-relative), never Date().
//  - Positions convert AppKit bottom-left screen coords to top-left normalized [0,1] against
//    the CAPTURED SURFACE, at WRITE time (§3.2).
//  - Move events throttled to 120Hz; consecutive moves with displacement < 0.001 deduped.
//  - Appends to cursor.jsonl; flushes every 500ms.
//
import AppKit
import Foundation

/// Describes how to map a global screen point (AppKit, bottom-left origin, points) into the
/// captured surface's normalized top-left [0,1] space. Depends on the capture target (§5.1):
/// a display fills the display; a window maps against the window frame; a region maps against
/// the sourceRect. SCRecorder builds this once the stream config is known.
struct SurfaceMapping {
    /// The capture rect in GLOBAL AppKit screen coordinates (bottom-left origin, points).
    /// For a display: the display frame. For a window: the window frame. For a region: the
    /// region rect in global coords.
    let captureRectGlobalBL: CGRect

    /// The height of the primary display (screen 0) in points, used to flip bottom-left to
    /// top-left. AppKit's global coordinate space has its origin at the bottom-left of the
    /// primary display.
    let primaryDisplayHeight: CGFloat

    /// Map a global mouse location (as reported by NSEvent.mouseLocation / event coordinates,
    /// bottom-left origin) to normalized [0,1] against the captured surface, top-left origin.
    /// Returns nil if the point is outside the captured surface (we simply don't record it).
    func normalize(globalBottomLeft p: CGPoint) -> (x: Double, y: Double)? {
        let r = captureRectGlobalBL
        guard r.width > 0, r.height > 0 else { return nil }
        // X: straightforward, both origins share the left edge.
        let nx = (p.x - r.minX) / r.width
        // Y: AppKit is bottom-left; we want top-left within the capture rect. The point's
        // distance from the TOP of the capture rect is (r.maxY - p.y).
        let ny = (r.maxY - p.y) / r.height
        if nx < 0 || nx > 1 || ny < 0 || ny > 1 { return nil }
        return (Double(nx), Double(ny))
    }
}

/// Writes cursor.jsonl and owns the two NSEvent monitors.
final class EventMonitor {

    private let clock: ClockSync
    private let mapping: SurfaceMapping
    private let detectTyping: Bool
    private let writer: CursorLogWriter

    // Monitor handles (opaque objects returned by NSEvent.addMonitor...). Removed on stop.
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var flushTimer: Timer?

    // --- move throttle / dedupe state (§3.2) ---
    private var lastMoveWriteTime: Double = -.greatestFiniteMagnitude // session-relative s
    private var lastMoveX: Double = -1
    private var lastMoveY: Double = -1
    private static let moveMinInterval: Double = 1.0 / 120.0 // 120Hz throttle
    private static let moveMinDisplacement: Double = 0.001    // dedupe threshold

    /// The set of NSEvent masks we watch. Key events only when detectTyping is on.
    private var eventMask: NSEvent.EventTypeMask {
        var mask: NSEvent.EventTypeMask = [
            .mouseMoved,
            .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .scrollWheel
        ]
        if detectTyping {
            mask.insert(.keyDown)
        }
        return mask
    }

    init(clock: ClockSync, mapping: SurfaceMapping, detectTyping: Bool,
         cursorFileURL: URL) throws {
        self.clock = clock
        self.mapping = mapping
        self.detectTyping = detectTyping
        self.writer = try CursorLogWriter(url: cursorFileURL)
    }

    /// Install both monitors and start the 500ms flush timer. Must be called on the main
    /// thread (NSEvent monitors and Timer.scheduledTimer require the main run loop).
    func start() {
        // TODO(mac): NSEvent.addGlobalMonitorForEvents returns nil (no error) if the process
        // lacks the required permission for keyDown (Input Monitoring). Mouse events need no
        // permission (§5.4). We must verify keyDown delivery on clean 14/15 VMs.
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event)
            return event // pass local events through unchanged
        }
        // Flush cursor.jsonl every 500ms (§3.2).
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.writer.flush()
        }
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer
        log("event monitors installed (detectTyping=\(detectTyping))")
    }

    /// Remove monitors, final-flush and close the file. Safe to call once.
    func stop() {
        if let g = globalMonitor { NSEvent.removeMonitor(g); globalMonitor = nil }
        if let l = localMonitor { NSEvent.removeMonitor(l); localMonitor = nil }
        flushTimer?.invalidate(); flushTimer = nil
        writer.flush()
        writer.close()
    }

    // MARK: - Event handling

    private func handle(_ event: NSEvent) {
        // STEP: timestamp via the clock domain. If the origin isn't established yet (no
        // committed frame), drop — we cannot place the event on the timeline. §5.3 only
        // requires dropping t<0; pre-origin events are effectively t<0.
        guard let t = clock.relativeTime(forEventTimestamp: event.timestamp) else { return }

        switch event.type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            handleMoveLike(event, t: t)
        case .leftMouseDown:
            writeMouse(.down, button: .left, event: event, t: t)
        case .leftMouseUp:
            writeMouse(.up, button: .left, event: event, t: t)
        case .rightMouseDown:
            writeMouse(.down, button: .right, event: event, t: t)
        case .rightMouseUp:
            writeMouse(.up, button: .right, event: event, t: t)
        case .otherMouseDown:
            writeMouse(.down, button: .other, event: event, t: t)
        case .otherMouseUp:
            writeMouse(.up, button: .other, event: event, t: t)
        case .scrollWheel:
            writeScroll(event, t: t)
        case .keyDown:
            // TIMING ONLY. No keycode, no characters. Privacy is contractual (§3.2).
            writer.append(CursorEvent(t: t, e: .key))
        default:
            break
        }
    }

    private func handleMoveLike(_ event: NSEvent, t: Double) {
        guard let (x, y) = normalizedLocation(of: event) else { return }
        // Drags are semantically "drag" moves; plain moves are "move".
        let isDrag = event.type == .leftMouseDragged
            || event.type == .rightMouseDragged
            || event.type == .otherMouseDragged
        // Throttle to 120Hz (§3.2). Downs/ups/scrolls are never throttled.
        if t - lastMoveWriteTime < EventMonitor.moveMinInterval { return }
        // Dedupe tiny displacement (§3.2).
        let moved = normDistance(x, y, lastMoveX, lastMoveY)
        if lastMoveX >= 0 && moved < EventMonitor.moveMinDisplacement { return }
        lastMoveWriteTime = t
        lastMoveX = x
        lastMoveY = y
        writer.append(CursorEvent(t: t, x: x, y: y, e: isDrag ? .drag : .move))
    }

    private func writeMouse(_ kind: CursorEventKind, button: MouseButton,
                            event: NSEvent, t: Double) {
        guard let (x, y) = normalizedLocation(of: event) else { return }
        writer.append(CursorEvent(t: t, x: x, y: y, e: kind, b: button))
    }

    private func writeScroll(_ event: NSEvent, t: Double) {
        guard let (x, y) = normalizedLocation(of: event) else { return }
        // scrollingDeltaY is the precise (pixel/line) delta; deltaY is the classic value.
        // TODO(mac): decide pixel vs line delta once auto-zoom scroll scoring is tuned; §3.2
        // example uses whole numbers, so classic deltaY is the closer match for now.
        let dy = Double(event.deltaY)
        writer.append(CursorEvent(t: t, x: x, y: y, e: .scroll, dy: dy))
    }

    /// Global screen location of an event -> normalized top-left [0,1] against the captured
    /// surface. NSEvent.locationInWindow is window-relative; for global monitors there is no
    /// window, so we use NSEvent.mouseLocation which is the CURRENT global cursor position in
    /// AppKit bottom-left coordinates. For mouse events this equals the event location.
    private func normalizedLocation(of event: NSEvent) -> (x: Double, y: Double)? {
        // NSEvent.mouseLocation reflects the location at the moment we read it, which for a
        // just-delivered event is the event location. This avoids per-window coordinate math.
        let global = NSEvent.mouseLocation
        return mapping.normalize(globalBottomLeft: global)
    }
}

// MARK: - CursorLogWriter — buffered append to cursor.jsonl

/// Appends CursorEvents as NDJSON, buffering in memory and flushing every 500ms (or on
/// demand). Thread-confined to the main thread (all appends come from NSEvent callbacks on
/// the main run loop); if that changes, add a lock.
final class CursorLogWriter {
    private let handle: FileHandle
    private var buffer = Data()
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    init(url: URL) throws {
        // Create (truncate) the file, then open for appending writes.
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: url) else {
            throw SidecarError(code: "capture.cursorFileOpenFailed",
                               message: "cannot open \(url.path) for writing")
        }
        self.handle = h
    }

    func append(_ event: CursorEvent) {
        do {
            var data = try encoder.encode(event)
            data.append(0x0A)
            buffer.append(data)
            // Bound memory if the flush timer stalls.
            if buffer.count > 64 * 1024 { flush() }
        } catch {
            log("cursor encode failed:", error)
        }
    }

    func flush() {
        guard !buffer.isEmpty else { return }
        handle.write(buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    func close() {
        flush()
        try? handle.close()
    }
}
