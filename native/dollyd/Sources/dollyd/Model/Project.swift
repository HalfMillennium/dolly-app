//
//  Project.swift
//  dollyd
//
//  Curated, ergonomic Codable models for the DOLLY data contracts (BUILD_PLAN §3.2–§3.4).
//
//  The JSON Schemas in packages/schema/schema/*.json are the source of truth. In CI,
//  `scripts/gen-swift.sh` regenerates `Model/Generated.swift` (a mechanical mirror of the
//  schema). This file is the HAND-CURATED companion: the same shapes, but with the enums,
//  computed helpers and oneOf handling that make the model pleasant to use from Swift. When
//  the two disagree, the schema (and Generated.swift) win; update this file to match.
//
//  Reference: Model/Generated.swift (produced separately by the schema codegen) will exist
//  alongside this file and declares the raw types; nothing here should duplicate a decl there
//  once codegen lands — for the first-draft we keep the full definitions here so the target
//  compiles standalone.
//
import Foundation

// MARK: - cursor.jsonl (§3.2)

public enum CursorEventKind: String, Codable {
    case move, down, up, drag, scroll, key
}

public enum MouseButton: String, Codable {
    case left, right, other
}

/// One line of cursor.jsonl. Timestamps are seconds relative to the PTS of the first written
/// video frame (§3.2, §5.3). `x`/`y` are normalized [0,1] top-left; absent for `key`.
public struct CursorEvent: Codable {
    public var t: Double
    public var x: Double?
    public var y: Double?
    public var e: CursorEventKind
    public var b: MouseButton?
    public var dy: Double?

    public init(t: Double, x: Double? = nil, y: Double? = nil, e: CursorEventKind,
                b: MouseButton? = nil, dy: Double? = nil) {
        self.t = t; self.x = x; self.y = y; self.e = e; self.b = b; self.dy = dy
    }
}

// MARK: - project.json (§3.3)

public struct Source: Codable {
    public var master: String
    public var proxy: String
    public var width: Int
    public var height: Int
    public var fps: Double
    public var duration: Double
    public var scale: Double
}

public enum AudioRole: String, Codable {
    case system, mic
}

public struct AudioTrack: Codable {
    public var file: String
    public var role: AudioRole
    public var gain: Double
    public var muted: Bool
}

public struct Trim: Codable {
    public var `in`: Double
    public var out: Double
}

/// Backdrop is a schema `oneOf` (gradient | solid). Modeled as an enum with a custom Codable.
public enum Backdrop: Codable {
    case gradient(from: String, to: String, angle: Double)
    case solid(color: String)

    private enum CodingKeys: String, CodingKey {
        case type, from, to, angle, color
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "gradient":
            self = .gradient(from: try c.decode(String.self, forKey: .from),
                             to: try c.decode(String.self, forKey: .to),
                             angle: try c.decode(Double.self, forKey: .angle))
        case "solid":
            self = .solid(color: try c.decode(String.self, forKey: .color))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c,
                debugDescription: "unknown backdrop type \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .gradient(from, to, angle):
            try c.encode("gradient", forKey: .type)
            try c.encode(from, forKey: .from)
            try c.encode(to, forKey: .to)
            try c.encode(angle, forKey: .angle)
        case let .solid(color):
            try c.encode("solid", forKey: .type)
            try c.encode(color, forKey: .color)
        }
    }
}

public struct Shadow: Codable {
    public var enabled: Bool
    public var opacity: Double
    public var blur: Double
    public var y: Double
}

public struct Composition: Codable {
    public var backdrop: Backdrop
    public var padding: Double
    public var radius: Double
    public var shadow: Shadow
}

public struct CursorStyle: Codable {
    public var visible: Bool
    public var size: Double
    public var smoothing: Double
    public var clickRipple: Bool
    public var hideWhenIdle: Double
}

public enum ZoomOrigin: String, Codable {
    case auto, manual
}

/// Zoom focal is a schema `oneOf` (fixed | follow).
public enum ZoomFocal: Codable {
    case fixed(x: Double, y: Double)
    case follow(damping: Double, track: String)

    private enum CodingKeys: String, CodingKey {
        case mode, x, y, damping, track
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try c.decode(String.self, forKey: .mode)
        switch mode {
        case "fixed":
            self = .fixed(x: try c.decode(Double.self, forKey: .x),
                          y: try c.decode(Double.self, forKey: .y))
        case "follow":
            self = .follow(damping: try c.decode(Double.self, forKey: .damping),
                           track: try c.decode(String.self, forKey: .track))
        default:
            throw DecodingError.dataCorruptedError(forKey: .mode, in: c,
                debugDescription: "unknown focal mode \(mode)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .fixed(x, y):
            try c.encode("fixed", forKey: .mode)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
        case let .follow(damping, track):
            try c.encode("follow", forKey: .mode)
            try c.encode(damping, forKey: .damping)
            try c.encode(track, forKey: .track)
        }
    }
}

public struct Zoom: Codable {
    public var id: String
    public var start: Double
    public var end: Double
    public var scale: Double
    public var focal: ZoomFocal
    public var rampIn: Double
    public var rampOut: Double
    public var easing: Easing   // defined in RenderMath.swift
    public var origin: ZoomOrigin
}

public struct SpeedSegment: Codable {
    public var start: Double
    public var end: Double
    public var rate: Double
}

/// autoZoom.lastRunParams is an open object in the schema; we preserve it verbatim as JSON.
public struct AutoZoomMeta: Codable {
    public var lastRunParams: JSONValue
    public var generatedAt: String
}

public struct Project: Codable {
    public var version: Int
    public var source: Source
    public var audio: [AudioTrack]
    public var trim: Trim
    public var composition: Composition
    public var cursor: CursorStyle
    public var zooms: [Zoom]
    public var speed: [SpeedSegment]
    public var autoZoom: AutoZoomMeta?
}

// MARK: - Sidecar protocol (§3.4)

public enum Quality: String, Codable {
    case studio, quick
}

public enum ExportPreset: String, Codable {
    case h264_1080p = "h264-1080p"
    case h264_4k = "h264-4k"
    case hevc_4k = "hevc-4k"
    case gif_720p = "gif-720p"
}

/// Capture target is a schema `oneOf` (display | window | region).
public enum CaptureTarget: Codable {
    case display(id: Int)
    case window(id: Int)
    case region(display: Int, rect: RectValue)

    private enum CodingKeys: String, CodingKey {
        case kind, id, display, rect
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "display":
            self = .display(id: try c.decode(Int.self, forKey: .id))
        case "window":
            self = .window(id: try c.decode(Int.self, forKey: .id))
        case "region":
            self = .region(display: try c.decode(Int.self, forKey: .display),
                           rect: try c.decode(RectValue.self, forKey: .rect))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c,
                debugDescription: "unknown target kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .display(id):
            try c.encode("display", forKey: .kind); try c.encode(id, forKey: .id)
        case let .window(id):
            try c.encode("window", forKey: .kind); try c.encode(id, forKey: .id)
        case let .region(display, rect):
            try c.encode("region", forKey: .kind)
            try c.encode(display, forKey: .display)
            try c.encode(rect, forKey: .rect)
        }
    }
}

public struct RectValue: Codable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }
}

/// A decoded request. We decode `cmd` first, then the payload for that command. Kept as an
/// enum so `main.swift`'s dispatch is an exhaustive switch.
public enum SidecarRequest {
    case listSources(id: Int)
    case ping(id: Int)
    case start(ReqStart)
    case stop(id: Int)
    case export(ReqExport)

    public var id: Int {
        switch self {
        case let .listSources(id): return id
        case let .ping(id): return id
        case let .start(r): return r.id
        case let .stop(id): return id
        case let .export(r): return r.id
        }
    }
}

public struct ReqStart: Codable {
    public var id: Int
    public var cmd: String
    public var target: CaptureTarget
    public var quality: Quality
    public var mic: String?
    public var systemAudio: Bool
    public var detectTyping: Bool?
    public var out: String
}

public struct ReqExport: Codable {
    public var id: Int
    public var cmd: String
    public var project: String
    public var out: String
    public var preset: ExportPreset
}

/// Minimal envelope used to peek at `id`/`cmd` before decoding the full request.
struct RequestEnvelope: Codable {
    var id: Int
    var cmd: String
}

extension SidecarRequest {
    /// Decode a single NDJSON request line. Throws on malformed / unknown command.
    static func decode(_ data: Data, using decoder: JSONDecoder) throws -> SidecarRequest {
        let env = try decoder.decode(RequestEnvelope.self, from: data)
        switch env.cmd {
        case "listSources": return .listSources(id: env.id)
        case "ping": return .ping(id: env.id)
        case "stop": return .stop(id: env.id)
        case "start": return .start(try decoder.decode(ReqStart.self, from: data))
        case "export": return .export(try decoder.decode(ReqExport.self, from: data))
        default:
            throw SidecarError(code: "protocol.unknownCommand",
                               message: "unknown cmd \(env.cmd)")
        }
    }
}

// MARK: - Responses & events (§3.4)

public struct DisplayInfo: Codable {
    public var id: Int
    public var width: Int
    public var height: Int
    public var scale: Double
    public var name: String
}

public struct WindowInfo: Codable {
    public var id: Int
    public var app: String
    public var title: String
    public var frame: RectValue
    public var thumb: String?   // base64 data URI (§5.1)
}

/// Responses are heterogeneous ({id,ok,...}); we build them as `JSONValue` objects so each
/// command can attach its own fields while `id`/`ok` stay consistent.
public enum SidecarMessage {
    case response(id: Int, ok: Bool, fields: [String: JSONValue])
    case error(id: Int, code: String, message: String) // {id,ok:false,code,msg}
    case eventRecording(t: Double, dropped: Int)
    case eventExportProgress(p: Double, fps: Double)
    case eventError(code: String, message: String)     // {ev:"error",...}

    /// Serialize to a single-line JSON object.
    public func jsonLine(using encoder: JSONEncoder) throws -> Data {
        let value: JSONValue
        switch self {
        case let .response(id, ok, fields):
            var obj: [String: JSONValue] = ["id": .number(Double(id)), "ok": .bool(ok)]
            for (k, v) in fields { obj[k] = v }
            value = .object(obj)
        case let .error(id, code, message):
            value = .object(["id": .number(Double(id)), "ok": .bool(false),
                             "code": .string(code), "msg": .string(message)])
        case let .eventRecording(t, dropped):
            value = .object(["ev": .string("recording"), "t": .number(t),
                             "dropped": .number(Double(dropped))])
        case let .eventExportProgress(p, fps):
            value = .object(["ev": .string("exportProgress"), "p": .number(p),
                             "fps": .number(fps)])
        case let .eventError(code, message):
            value = .object(["ev": .string("error"), "code": .string(code),
                             "msg": .string(message)])
        }
        return try encoder.encode(value)
    }
}

// MARK: - Errors

/// A structured sidecar error with a TCC/other stable code (see §3.4 error codes like
/// `tcc.screenRecording.denied`).
public struct SidecarError: Error {
    public let code: String
    public let message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - JSONValue (a small dynamic JSON node)

/// A minimal JSON value used for open-ended objects (`autoZoom.lastRunParams`) and for
/// assembling heterogeneous responses without a bespoke struct per command.
public enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unrepresentable JSON")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .number(n): try c.encode(n)
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }
}
