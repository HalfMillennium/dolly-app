//
//  ClockSync.swift
//  dollyd
//
//  *** THE MOST IMPORTANT MATH IN THE SIDECAR — read BUILD_PLAN §5.3 twice. ***
//
//  The cursor telemetry track and the video track MUST share one clock domain. If they
//  disagree by even ~100ms, auto-zoom lands on the wrong moment and the whole feature feels
//  broken. This type is the single place that reconciles the two clocks.
//
//  The two clocks involved
//  -----------------------
//  1. VIDEO: `CMSampleBuffer`s delivered by `SCStream` carry a presentation timestamp (PTS)
//     on `CMClockGetHostTimeClock()`. That host clock is mach_absolute_time() expressed as a
//     CMTime. `CMSampleBufferGetPresentationTimeStamp(sb)` -> CMTime -> seconds gives us the
//     PTS on the SAME timebase as (2).
//
//  2. EVENTS: `NSEvent.timestamp` is "seconds since the system booted" — and, crucially, it
//     is the SAME base as `mach_absolute_time()` scaled by `mach_timebase_info`. So an
//     NSEvent timestamp and a video-sample host-clock time are directly comparable once both
//     are expressed in seconds.
//
//  The procedure (BUILD_PLAN §5.3)
//  -------------------------------
//  1. On the FIRST video sample buffer actually COMMITTED to the writer, record
//         t0 = CMSampleBufferGetPresentationTimeStamp(sb) as seconds on the host clock.
//     (Committed, not merely received — a dropped/!ready first frame must not set t0, or the
//      cursor track would be offset from the video that actually made it to disk.)
//  2. For each event, eventT = NSEvent.timestamp (already host-clock seconds since boot).
//  3. Write t = eventT - t0. Drop events with t < 0 (they happened before the first frame).
//  4. NEVER use Date() or CACurrentMediaTime() in this path. Date() is wall-clock (NTP steps,
//     DST) and CACurrentMediaTime() is a convenience wrapper we avoid to keep the derivation
//     explicit and auditable.
//
//  Why not CACurrentMediaTime()? It happens to return mach time in seconds too, so it would
//  "work" — but §5.3 forbids it precisely so there is exactly ONE conversion path here and no
//  temptation to timestamp an event with "now" instead of its real NSEvent.timestamp.
//
import CoreMedia
import Foundation

/// Reconciles ScreenCaptureKit video PTS with NSEvent timestamps into a single relative
/// timeline whose origin is the first committed video frame.
///
/// Thread-safety: `markFirstCommittedFrame` is called from the SCStream sample callback; the
/// `relativeTime(forEventTimestamp:)` reads happen on the event-monitor callbacks. Access to
/// `t0Seconds` is guarded by an unfair lock because the two live on different queues.
final class ClockSync {

    /// The presentation timestamp of the first committed video frame, in host-clock seconds.
    /// `nil` until the first frame is committed. Once set, never changes for the session.
    private var t0Seconds: Double?

    private let lock = NSLock()

    /// True once the video origin is established. Events arriving before this is set are
    /// buffered by the caller (EventMonitor) and re-timestamped once t0 is known — see note
    /// in EventMonitor. Alternatively they can be dropped; §5.3 only requires dropping t<0.
    var isEstablished: Bool {
        lock.lock(); defer { lock.unlock() }
        return t0Seconds != nil
    }

    /// STEP 1. Establish the clock origin from the first COMMITTED video sample buffer.
    /// Idempotent: only the first call sets t0; later calls are ignored (the origin is the
    /// first frame, forever).
    ///
    /// - Parameter sampleBuffer: the sample buffer that was just appended to the master
    ///   writer input (i.e. `isReadyForMoreMediaData` was true and append succeeded).
    func markFirstCommittedFrame(_ sampleBuffer: CMSampleBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard t0Seconds == nil else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        // CMTimeGetSeconds on a host-clock PTS yields seconds on CMClockGetHostTimeClock(),
        // which shares mach_absolute_time()'s base — the same base as NSEvent.timestamp.
        t0Seconds = CMTimeGetSeconds(pts)
        log("clock origin established: t0 =", t0Seconds ?? -1, "s (host clock)")
    }

    /// STEPS 2–3. Convert an NSEvent timestamp (host-clock seconds since boot) into the
    /// session-relative timeline. Returns `nil` if:
    ///   - the origin is not established yet (caller should buffer or drop), or
    ///   - the resulting t < 0 (event predates the first frame — DROP per §5.3).
    ///
    /// - Parameter eventTimestamp: `NSEvent.timestamp` directly. Do NOT pass Date() or
    ///   CACurrentMediaTime() — that is exactly the bug this file exists to prevent.
    func relativeTime(forEventTimestamp eventTimestamp: TimeInterval) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        guard let t0 = t0Seconds else { return nil }
        let t = eventTimestamp - t0
        if t < 0 { return nil } // §5.3 step 3: drop events before the first committed frame
        return t
    }

    /// Convenience for tests / the flash detector: convert an arbitrary host-clock-seconds
    /// timestamp (e.g. a decoded frame's PTS during the acceptance test) to the same relative
    /// timeline. Same math, no t<0 drop (a frame's PTS is always >= t0 by construction, but
    /// we still allow negative for diagnostics).
    func relativeTime(forHostSeconds hostSeconds: Double) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        guard let t0 = t0Seconds else { return nil }
        return hostSeconds - t0
    }

    /// The established origin in host-clock seconds, for diagnostics. `nil` until step 1.
    var originHostSeconds: Double? {
        lock.lock(); defer { lock.unlock() }
        return t0Seconds
    }
}

// MARK: - mach timebase reference (documentation)

// NSEvent.timestamp and CMClockGetHostTimeClock() both derive from mach_absolute_time(). For
// reference / if we ever need to convert a raw mach tick to seconds ourselves (we do NOT in
// the hot path — we let CMTimeGetSeconds and NSEvent.timestamp do it), the conversion is:
//
//     var tb = mach_timebase_info_data_t()
//     mach_timebase_info(&tb)
//     let seconds = Double(mach_absolute_time()) * Double(tb.numer) / Double(tb.denom) / 1e9
//
// This is here only to document that NSEvent.timestamp is that exact quantity, which is why
// subtracting t0 (also derived from that base) is valid. Do not call this on the event path.
// TODO(mac): on Apple Silicon confirm CMClockGetHostTimeClock() == mach base (it does on all
// shipping macOS, but the §5.3 acceptance test is what actually proves the reconciliation).
