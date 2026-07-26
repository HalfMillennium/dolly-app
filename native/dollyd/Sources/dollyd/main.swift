//
//  main.swift
//  dollyd
//
//  The stdin/stdout NDJSON protocol loop (BUILD_PLAN §3.4).
//
//  - Reads one JSON request per line from stdin.
//  - Dispatches listSources / start / stop / export / ping.
//  - Writes {id,ok,...} responses and {ev,...} events as single JSON lines to stdout.
//  - Logs plain text to stderr (never parsed by the shell).
//
//  Threading model: the read loop runs on a dedicated thread and dispatches command handling
//  onto a serial queue so that at most one long-running operation (capture session setup,
//  export) mutates shared state at a time. Capture/export drive their own background queues
//  and post events back through the shared `Emitter`, which serializes writes to stdout.
//
import AVFoundation
import Foundation

// MARK: - stderr logging

func log(_ items: Any..., function: String = #function) {
    let line = items.map { "\($0)" }.joined(separator: " ")
    FileHandle.standardError.write(Data(("[dollyd] \(function): \(line)\n").utf8))
}

// MARK: - Emitter — serializes all stdout writes

/// All responses and events go through here. stdout must contain exactly one JSON object per
/// line; concurrent writers would interleave bytes, so every write is funneled through a
/// serial queue and terminated with a single '\n'.
final class Emitter {
    static let shared = Emitter()
    private let queue = DispatchQueue(label: "dolly.emitter")
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        // Compact, stable output. No pretty-printing (single-line requirement).
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    private let out = FileHandle.standardOutput

    func emit(_ message: SidecarMessage) {
        queue.async {
            do {
                var data = try message.jsonLine(using: self.encoder)
                data.append(0x0A) // '\n'
                self.out.write(data)
            } catch {
                log("failed to encode message:", error)
            }
        }
    }

    /// Convenience for {id,ok:true, ...fields}.
    func ok(id: Int, _ fields: [String: JSONValue] = [:]) {
        emit(.response(id: id, ok: true, fields: fields))
    }

    func fail(id: Int, code: String, message: String) {
        emit(.error(id: id, code: code, message: message))
    }
}

// MARK: - Sidecar controller

/// Owns the current capture session / export job and dispatches commands. One serial queue so
/// start/stop/export never race.
final class Sidecar {
    private let workQueue = DispatchQueue(label: "dolly.work")
    private let emitter = Emitter.shared

    // Active capture session, if recording (§5). Retained for stop.
    private var recorder: SCRecorder?
    // Active export job, if exporting (§6.6).
    private var exporter: Exporter?

    func handle(_ request: SidecarRequest) {
        workQueue.async { [weak self] in
            guard let self = self else { return }
            switch request {
            case let .ping(id):
                self.emitter.ok(id: id, ["pong": .bool(true)])
            case let .listSources(id):
                self.handleListSources(id: id)
            case let .start(req):
                self.handleStart(req)
            case let .stop(id):
                self.handleStop(id: id)
            case let .export(req):
                self.handleExport(req)
            }
        }
    }

    // MARK: listSources (§5.1)

    private func handleListSources(id: Int) {
        Task {
            do {
                let (displays, windows) = try await SCRecorder.enumerateSources()
                let displaysJSON = JSONValue.array(displays.map { self.encodeToJSON($0) })
                let windowsJSON = JSONValue.array(windows.map { self.encodeToJSON($0) })
                self.emitter.ok(id: id, ["displays": displaysJSON, "windows": windowsJSON])
            } catch let e as SidecarError {
                self.emitter.fail(id: id, code: e.code, message: e.message)
            } catch {
                self.emitter.fail(id: id, code: "capture.enumerateFailed",
                                  message: "\(error)")
            }
        }
    }

    // MARK: start (§5.2–§5.5)

    private func handleStart(_ req: ReqStart) {
        guard recorder == nil else {
            emitter.fail(id: req.id, code: "capture.alreadyRecording",
                         message: "a recording is already in progress")
            return
        }
        do {
            let recorder = try SCRecorder(request: req, emitter: emitter)
            self.recorder = recorder
            // start() is async — it begins the SCStream and installs event monitors. It
            // reports success once the first frame commits and the writers are live.
            Task {
                do {
                    try await recorder.start()
                    self.emitter.ok(id: req.id, ["path": .string(req.out)])
                } catch let e as SidecarError {
                    self.recorder = nil
                    self.emitter.fail(id: req.id, code: e.code, message: e.message)
                } catch {
                    self.recorder = nil
                    self.emitter.fail(id: req.id, code: "capture.startFailed",
                                      message: "\(error)")
                }
            }
        } catch let e as SidecarError {
            emitter.fail(id: req.id, code: e.code, message: e.message)
        } catch {
            emitter.fail(id: req.id, code: "capture.startFailed", message: "\(error)")
        }
    }

    // MARK: stop (§5.2)

    private func handleStop(id: Int) {
        guard let recorder = recorder else {
            emitter.fail(id: id, code: "capture.notRecording",
                         message: "no recording in progress")
            return
        }
        Task {
            do {
                let result = try await recorder.stop()
                self.recorder = nil
                self.emitter.ok(id: id, [
                    "path": .string(result.bundlePath),
                    "duration": .number(result.duration),
                    "dropped": .number(Double(result.droppedProxyFrames))
                ])
            } catch {
                self.recorder = nil
                self.emitter.fail(id: id, code: "capture.stopFailed", message: "\(error)")
            }
        }
    }

    // MARK: export (§6.6)

    private func handleExport(_ req: ReqExport) {
        guard exporter == nil else {
            emitter.fail(id: req.id, code: "export.alreadyRunning",
                         message: "an export is already in progress")
            return
        }
        do {
            let projectURL = URL(fileURLWithPath: req.project)
            let data = try Data(contentsOf: projectURL)
            let decoder = JSONDecoder()
            let project = try decoder.decode(Project.self, from: data)
            // project.json lives inside the .dolly bundle; media paths are relative to it.
            let bundleDir = projectURL.deletingLastPathComponent()
            let exporter = try Exporter(project: project, bundleDir: bundleDir,
                                        outURL: URL(fileURLWithPath: req.out),
                                        preset: req.preset, emitter: emitter)
            self.exporter = exporter
            Task {
                do {
                    let bytes = try await exporter.run()
                    self.exporter = nil
                    self.emitter.ok(id: req.id, [
                        "path": .string(req.out),
                        "bytes": .number(Double(bytes))
                    ])
                } catch let e as SidecarError {
                    self.exporter = nil
                    self.emitter.fail(id: req.id, code: e.code, message: e.message)
                } catch {
                    self.exporter = nil
                    self.emitter.fail(id: req.id, code: "export.failed", message: "\(error)")
                }
            }
        } catch {
            emitter.fail(id: req.id, code: "export.projectLoadFailed", message: "\(error)")
        }
    }

    // MARK: helpers

    /// Encode a Codable to a JSONValue by round-tripping through JSON data (cheap; called at
    /// enumerate time, not on the hot path).
    private func encodeToJSON<T: Encodable>(_ value: T) -> JSONValue {
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            log("encodeToJSON failed:", error)
            return .null
        }
    }
}

// MARK: - Read loop

/// Reads NDJSON lines from stdin and feeds them to the Sidecar. Runs until EOF (stdin closed
/// by the parent). We read raw bytes and split on '\n' to avoid any line-length limits or
/// locale issues in higher-level readers.
final class StdinLoop {
    private let sidecar = Sidecar()
    private let decoder = JSONDecoder()

    func run() {
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            // availableData blocks until data or EOF; returns empty Data at EOF.
            let chunk = input.availableData
            if chunk.isEmpty {
                log("stdin closed; exiting")
                break
            }
            buffer.append(chunk)
            // Process every complete line currently in the buffer.
            while let nl = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                let trimmed = lineData.trimmingTrailingCR()
                if trimmed.isEmpty { continue }
                dispatchLine(trimmed)
            }
        }
    }

    private func dispatchLine(_ data: Data) {
        do {
            let request = try SidecarRequest.decode(data, using: decoder)
            sidecar.handle(request)
        } catch let e as SidecarError {
            // We may not know the id; emit a general error event.
            Emitter.shared.emit(.eventError(code: e.code, message: e.message))
        } catch {
            // Try to salvage an id for a targeted error.
            if let env = try? decoder.decode(RequestEnvelope.self, from: data) {
                Emitter.shared.fail(id: env.id, code: "protocol.decodeFailed",
                                    message: "\(error)")
            } else {
                Emitter.shared.emit(.eventError(code: "protocol.decodeFailed",
                                                message: "\(error)"))
            }
        }
    }
}

private extension Data {
    /// Strip a trailing '\r' so CRLF and LF both work.
    func trimmingTrailingCR() -> Data {
        if last == 0x0D { return subdata(in: startIndex..<(endIndex - 1)) }
        return self
    }
}

// MARK: - Entry point

// AppKit's NSEvent global monitors and AVCaptureSession require a running main run loop. We
// run the stdin read loop on a background thread and hand the main thread to the run loop so
// that event monitors, ScreenCaptureKit callbacks and AVFoundation delegates all fire.
// TODO(mac): verify a plain `RunLoop.main.run()` is sufficient for NSEvent global monitors in
// a non-.app (LSUIElement / command-line) process, or whether an NSApplication is required.
// In practice global NSEvent monitors need an NSApplication instance; we create one but keep
// it accessory (no Dock icon, no menu) so the sidecar stays headless.
let loop = StdinLoop()
Thread.detachNewThread {
    loop.run()
    // When stdin closes, terminate the process cleanly.
    exit(0)
}

// Create an accessory NSApplication so global event monitors work, then run its loop.
// TODO(mac): confirm `.accessory` activation policy + no bundle Info.plist doesn't trip TCC.
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
