//
//  AudioTap.swift
//  dollyd
//
//  Audio capture into two SEPARATE AAC .m4a files (BUILD_PLAN §3.1, §5.5):
//    - audio-system.m4a : system audio delivered by SCStream (`.audio` sample buffers).
//    - audio-mic.m4a     : microphone via a separate AVCaptureSession.
//
//  Audio is kept OUT of the video container (§3.1) so the user can mute / re-balance at
//  export without a capture-time re-encode decision. Two files, two independent AAC encoders.
//
//  Timebase note: both audio writers start their session at the first audio sample's PTS.
//  They share the host clock with video (SCStream audio PTS is host-clock; AVCaptureSession
//  audio PTS is also host-clock), so at export the audio mix lines up with the video via
//  ordinary CMTime. The CURSOR track alone needs the explicit t0 subtraction (§5.3); audio
//  and video are already on the same CMTime timeline inside their containers.
//
import AVFoundation
import CoreMedia
import Foundation

/// Writes a single AAC .m4a from appended CMSampleBuffers. Used for the system-audio file;
/// the mic file uses the same writer fed by the capture session delegate.
final class AACFileWriter {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var started = false
    private let queue = DispatchQueue(label: "dolly.audio.file")

    init(url: URL) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,        // 48kHz per §3.1
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 160_000
        ]
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw SidecarError(code: "capture.audioWriterConfig",
                               message: "AAC writer rejected settings for \(url.lastPathComponent)")
        }
        writer.add(input)
    }

    func append(_ sampleBuffer: CMSampleBuffer) {
        queue.sync {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            if !started {
                started = true
                writer.startWriting()
                writer.startSession(atSourceTime: pts)
            }
            if input.isReadyForMoreMediaData {
                if !input.append(sampleBuffer) {
                    log("audio append failed:", writer.error as Any)
                }
            } else {
                // Audio backpressure is rare; we don't drop (audio gaps are audible).
                log("audio input not ready; sample at", CMTimeGetSeconds(pts))
            }
        }
    }

    func finish() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async {
                guard self.started else { cont.resume(); return }
                self.input.markAsFinished()
                self.writer.finishWriting { cont.resume() }
            }
        }
    }
}

/// Captures microphone audio via AVCaptureSession and forwards sample buffers to an
/// AACFileWriter. Separate from SCStream so mic works even if system audio is off.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let fileWriter: AACFileWriter
    private let sampleQueue = DispatchQueue(label: "dolly.audio.mic")

    /// - Parameters:
    ///   - deviceUID: the unique ID string from the `start` request's `mic` field (§3.4). If
    ///     nil we use the default audio input.
    ///   - url: destination audio-mic.m4a.
    init(deviceUID: String?, url: URL) throws {
        fileWriter = try AACFileWriter(url: url)
        super.init()

        let device: AVCaptureDevice?
        if let uid = deviceUID {
            device = AVCaptureDevice(uniqueID: uid)
                ?? AVCaptureDevice.default(for: .audio)
        } else {
            device = AVCaptureDevice.default(for: .audio)
        }
        guard let mic = device else {
            throw SidecarError(code: "capture.micNotFound",
                               message: "no microphone device available")
        }
        // TODO(mac): AVCaptureDeviceInput for audio can throw if the mic permission
        // (NSMicrophoneUsageDescription + TCC) hasn't been granted. Surface that as
        // tcc.microphone.denied at the call site by inspecting the thrown error.
        let deviceInput = try AVCaptureDeviceInput(device: mic)
        guard session.canAddInput(deviceInput) else {
            throw SidecarError(code: "capture.micInput",
                               message: "cannot add mic input to session")
        }
        session.addInput(deviceInput)
        output.setSampleBufferDelegate(self, queue: sampleQueue)
        guard session.canAddOutput(output) else {
            throw SidecarError(code: "capture.micOutput",
                               message: "cannot add mic output to session")
        }
        session.addOutput(output)
    }

    func start() {
        // startRunning blocks; run off the main thread.
        sampleQueue.async { [weak self] in self?.session.startRunning() }
    }

    func stop() async {
        session.stopRunning()
        await fileWriter.finish()
    }

    // MARK: AVCaptureAudioDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        fileWriter.append(sampleBuffer)
    }
}

/// Bundles the optional system-audio and mic writers so SCRecorder can drive both.
final class AudioTap {
    let systemWriter: AACFileWriter?   // fed from SCStream `.audio` buffers
    let mic: MicCapture?

    init(systemAudioURL: URL?, micDeviceUID: String?, micURL: URL?) throws {
        if let sysURL = systemAudioURL {
            systemWriter = try AACFileWriter(url: sysURL)
        } else {
            systemWriter = nil
        }
        if let micURL = micURL {
            mic = try MicCapture(deviceUID: micDeviceUID, url: micURL)
        } else {
            mic = nil
        }
    }

    func start() {
        mic?.start()
    }

    /// Called by SCRecorder for each SCStream `.audio` sample buffer.
    func appendSystemAudio(_ sampleBuffer: CMSampleBuffer) {
        systemWriter?.append(sampleBuffer)
    }

    func finish() async {
        await systemWriter?.finish()
        await mic?.stop()
    }
}
