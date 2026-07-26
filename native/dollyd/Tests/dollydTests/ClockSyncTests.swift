//
//  ClockSyncTests.swift
//  dollydTests
//
//  The BUILD_PLAN §5.3 clock-sync acceptance test.
//
//  Requirement (§5.3): a fixture app flashes the screen white and synthesizes a click at the
//  SAME runloop turn, ten times over 30 seconds. Detect the flash by scanning decoded frame
//  luminance; compare its timestamp to the `down` event's `t`. Require |Δ| < 16ms (one frame
//  @ 60fps) for all ten.
//
//  This is real (Mac-only) test code. Pieces that need on-device capture, UI automation, or
//  event synthesis are marked `// TODO(mac):`. The pure clock arithmetic (the actual thing
//  §5.3 defines) is unit-tested here WITHOUT hardware so CI on any machine catches regressions
//  in the reconciliation math; the full integration test runs on a Mac runner.
//
import CoreMedia
import XCTest
@testable import dollyd

final class ClockSyncTests: XCTestCase {

    // MARK: - Pure arithmetic (hardware-free, always runs)

    /// t = eventT - t0, with t0 taken from the first committed frame's PTS. Verifies the exact
    /// subtraction and the t<0 drop (§5.3 steps 1–3).
    func testRelativeTimeSubtractsOrigin() {
        let clock = ClockSync()
        // Simulate the first committed frame at host-clock PTS = 1000.5s.
        let sb = Self.makeSampleBuffer(ptsSeconds: 1000.5)
        clock.markFirstCommittedFrame(sb)

        // An event 0.25s later must map to t = 0.25.
        let t = clock.relativeTime(forEventTimestamp: 1000.75)
        XCTAssertNotNil(t)
        XCTAssertEqual(t!, 0.25, accuracy: 1e-9)
    }

    /// Events before the first committed frame (t < 0) are dropped (§5.3 step 3).
    func testDropsNegativeTimes() {
        let clock = ClockSync()
        clock.markFirstCommittedFrame(Self.makeSampleBuffer(ptsSeconds: 500.0))
        XCTAssertNil(clock.relativeTime(forEventTimestamp: 499.9)) // 0.1s before origin
        XCTAssertNotNil(clock.relativeTime(forEventTimestamp: 500.0)) // exactly at origin -> 0
    }

    /// The origin is set by the FIRST committed frame only; later frames don't move it
    /// (§5.3 step 1, "first video sample committed to the writer").
    func testOriginIsIdempotent() {
        let clock = ClockSync()
        clock.markFirstCommittedFrame(Self.makeSampleBuffer(ptsSeconds: 10.0))
        clock.markFirstCommittedFrame(Self.makeSampleBuffer(ptsSeconds: 99.0)) // ignored
        XCTAssertEqual(clock.originHostSeconds!, 10.0, accuracy: 1e-9)
        XCTAssertEqual(clock.relativeTime(forEventTimestamp: 12.0)!, 2.0, accuracy: 1e-9)
    }

    /// Before any frame commits, events cannot be placed and are reported nil (the caller
    /// drops/buffers). Guards against timestamping with a bogus origin of 0.
    func testNoOriginYieldsNil() {
        let clock = ClockSync()
        XCTAssertNil(clock.relativeTime(forEventTimestamp: 123.0))
        XCTAssertFalse(clock.isEstablished)
    }

    // MARK: - Full acceptance test (Mac-only, requires capture + event synthesis)

    /// §5.3 acceptance test: 10 flash+click pairs over 30s, |Δ| < 16ms for all ten.
    ///
    /// This test drives a real SCStream over a fixture window that flashes white, and
    /// synthesizes a mouse-down on the SAME runloop turn as each flash. It then decodes the
    /// recorded master, finds each flash by luminance, and compares the flash frame's relative
    /// time (via ClockSync) to the recorded `down` event's `t` in cursor.jsonl.
    ///
    /// It is skipped unless DOLLY_HW_TESTS=1 is set, because it needs Screen Recording
    /// permission and an interactive-ish session (a CI Mac runner with the TCC grant).
    func testFlashClickWithin16msAcceptance() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DOLLY_HW_TESTS"] == "1",
                          "hardware capture test; set DOLLY_HW_TESTS=1 on a Mac runner")

        let threshold = 0.016 // 16ms = one frame @ 60fps (§5.3)
        let flashCount = 10

        // TODO(mac): stand up the fixture.
        //  1. Create a small borderless NSWindow that renders solid black, with a method
        //     `flashWhiteAndClick()` that on ONE runloop turn:
        //        - sets its layer background to white for exactly one display frame, and
        //        - posts a synthetic left mouse-down at its center via CGEvent(mouseEventSource:
        //          ...).post(tap: .cghidEventTap)   // so it flows through NSEvent monitors
        //     Record the intended host-clock time only for diagnostics — the TEST's truth is
        //     the DECODED flash time vs the RECORDED event time, both already on the sidecar's
        //     own clock. We must NOT compare against Date().
        //  2. Start an SCRecorder targeting that window (showsCursor=false), detectTyping=false.
        //  3. Fire flashWhiteAndClick() 10 times spaced ~3s apart over 30s.
        //  4. stop().
        //
        // let bundle = URL(fileURLWithPath: NSTemporaryDirectory())
        //     .appendingPathComponent("clocksync.dolly")
        // let recorder = try SCRecorder(request: fixtureStartRequest(out: bundle.path),
        //                               emitter: Emitter.shared)
        // try await recorder.start()
        // for _ in 0..<flashCount { fixture.flashWhiteAndClick(); wait(3) }
        // let result = try await recorder.stop()

        // --- Analysis (this part is hardware-free given a recorded bundle) ---
        // let bundleURL = ...
        // let flashTimes = try Self.detectFlashTimes(inMasterAt:
        //     bundleURL.appendingPathComponent("master.mov"))
        // let clickTimes = try Self.readClickTimes(fromCursorAt:
        //     bundleURL.appendingPathComponent("cursor.jsonl"))
        // XCTAssertEqual(flashTimes.count, flashCount)
        // XCTAssertEqual(clickTimes.count, flashCount)
        // for (flash, click) in zip(flashTimes.sorted(), clickTimes.sorted()) {
        //     XCTAssertLessThan(abs(flash - click), threshold,
        //                       "flash/click skew \(abs(flash - click))s exceeds 16ms")
        // }

        _ = (threshold, flashCount)
        XCTFail("TODO(mac): wire up the fixture window + capture on a Mac runner")
    }

    // MARK: - Flash detection (luminance scan of decoded master, hardware-free)

    /// Decode the master and return the relative times (seconds) of frames whose mean
    /// luminance jumps above a threshold — i.e. the white flashes (§5.3 "detect the flash by
    /// scanning decoded frame luminance"). This runs anywhere given a file; it is exercised by
    /// the acceptance test on a Mac runner and can be unit-tested against a synthetic fixture.
    static func detectFlashTimes(inMasterAt url: URL) throws -> [Double] {
        // TODO(mac): full implementation with AVAssetReader + a luminance-mean over each
        // decoded CVPixelBuffer (convert BGRA -> luma with 0.2126R+0.7152G+0.0722B, or use a
        // CIAreaAverage). Detect rising edges above, say, 0.8 mean luma. Return the PTS of
        // each rising edge converted to seconds relative to the first frame (which is t0 for
        // this decoded asset). The relative-time convention matches cursor.jsonl (§3.2).
        //
        // Sketch:
        //   let asset = AVURLAsset(url: url)
        //   let reader = try AVAssetReader(asset: asset)
        //   let track = try await asset.loadTracks(withMediaType: .video).first!
        //   let out = AVAssetReaderTrackOutput(track: track, outputSettings:
        //       [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        //   reader.add(out); reader.startReading()
        //   var firstPTS: Double? = nil; var times: [Double] = []; var wasBright = false
        //   while let sb = out.copyNextSampleBuffer() {
        //       let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        //       if firstPTS == nil { firstPTS = pts }
        //       let luma = meanLuma(CMSampleBufferGetImageBuffer(sb)!)
        //       if luma > 0.8 && !wasBright { times.append(pts - firstPTS!); wasBright = true }
        //       if luma < 0.4 { wasBright = false }
        //   }
        //   return times
        throw XCTSkip("TODO(mac): implement luminance flash detection with AVAssetReader")
    }

    /// Read the `down` event times from cursor.jsonl (§3.2). Hardware-free.
    static func readClickTimes(fromCursorAt url: URL) throws -> [Double] {
        let data = try Data(contentsOf: url)
        let text = String(decoding: data, as: UTF8.self)
        let decoder = JSONDecoder()
        var times: [Double] = []
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let ev = try? decoder.decode(CursorEvent.self, from: d) else { continue }
            if ev.e == .down { times.append(ev.t) }
        }
        return times
    }

    // MARK: - Test helpers

    /// Build a CMSampleBuffer carrying only a presentation timestamp on the host-clock
    /// timescale. We attach a tiny dummy format description / block buffer so the sample is
    /// valid enough for CMSampleBufferGetPresentationTimeStamp.
    static func makeSampleBuffer(ptsSeconds: Double) -> CMSampleBuffer {
        // TODO(mac): on device this is trivially a real sample; here we synthesize a minimal
        // timing-only sample buffer. Uses a 1-byte block buffer and a dummy format desc.
        let pts = CMTime(seconds: ptsSeconds, preferredTimescale: 1_000_000_000)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 60),
                                        presentationTimeStamp: pts,
                                        decodeTimeStamp: .invalid)
        var blockBuffer: CMBlockBuffer?
        CMBlockBufferCreateEmpty(allocator: kCFAllocatorDefault, capacity: 0,
                                 flags: 0, blockBufferOut: &blockBuffer)
        var formatDesc: CMFormatDescription?
        // A minimal format description; we only read timing so any valid desc works.
        CMFormatDescriptionCreate(allocator: kCFAllocatorDefault,
                                  mediaType: kCMMediaType_Video,
                                  mediaSubType: kCMVideoCodecType_422YpCbCr8,
                                  extensions: nil, formatDescriptionOut: &formatDesc)
        var sampleBuffer: CMSampleBuffer?
        CMSampleBufferCreate(allocator: kCFAllocatorDefault,
                             dataBuffer: blockBuffer, dataReady: true,
                             makeDataReadyCallback: nil, refcon: nil,
                             formatDescription: formatDesc,
                             sampleCount: 1, sampleTimingEntryCount: 1,
                             sampleTimingArray: &timing,
                             sampleSizeEntryCount: 0, sampleSizeArray: nil,
                             sampleBufferOut: &sampleBuffer)
        return sampleBuffer!
    }
}
