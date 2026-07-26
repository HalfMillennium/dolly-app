# DOLLY — Technical Build Plan

Local-first macOS screen recorder with cursor-driven auto-zoom. Codename DOLLY.
Target: a Cap-class capture + edit + export tool, no server, no account.

This document is the implementation contract. Sections 1–4 are decisions; do not
re-litigate them without a stated reason. Sections 5–9 are the work.

---

## 1. Scope

### In scope for v1
- Capture a display, a window, or a dragged region at up to 4K60 with system audio and mic on separate tracks.
- Record a cursor telemetry track in the same clock domain as the video.
- Non-destructive editor: trim, zoom segments, composition (backdrop, padding, corner radius, shadow), cursor styling, playback speed.
- Auto-zoom: derive zoom segments from the cursor track, emitted as ordinary editable segments.
- Export to H.264/HEVC MP4 faster than real time.
- Local project bundles; reopening a project restores exact edit state.

### Explicitly out of scope for v1
Cloud upload, share links, team workspaces, comments, viewer analytics, custom domains, embed player, Windows/Linux.

### Deferred to v1.1 (design for, don't build)
Local transcription (whisper.cpp) → chapters, titles, `.srt`. Multi-clip timeline. Camera overlay / picture-in-picture. Background blur.

### Definition of done for v1
A notarized `.app` a stranger can download, open, grant one permission, record a 5-minute Chrome session, get sensible auto-zooms without touching anything, adjust two of them, and export a 1080p MP4 in under half the recording's duration.

---

## 2. Architecture decisions

### 2.1 Shell: Tauri v2, not Electron
Rust core + WKWebView frontend. Bundle size (~15MB vs ~150MB), and every performance-critical path is native anyway. Switch to Electron only if frame-accurate scrubbing in WKWebView proves unworkable after the M3 spike. Record that finding before switching.

### 2.2 Capture: Swift sidecar, not a Rust binding
A standalone Swift executable (`dollyd`) owns ScreenCaptureKit, AVAssetWriter, and event monitoring. Tauri spawns it as a sidecar and talks over stdin/stdout with newline-delimited JSON. The seam is narrow — four commands, one telemetry stream. Cost: the sidecar must be separately signed and included in `Contents/MacOS/`.

### 2.3 Two renderers, one document
- **Preview** renders in the webview (2D canvas, upgrade to WebGL2 only if profiling demands it).
- **Export** renders natively (Core Image chain; Metal if Core Image can't hold 60fps at 4K).
Both driven by the same `project.json`. Largest correctness risk — see §6.6 parity test.

### 2.4 Proxy workflow
Capture **always** writes two files simultaneously:

| File | Codec | Purpose |
|---|---|---|
| `master.mov` | ProRes 422 LT, or H.264 all-intra | export source |
| `proxy.mp4` | H.264, 1280px wide, GOP = 15 frames | editor playback and scrubbing |

For "Quick" mode, skip ProRes and let `master.mp4` be H.264 with a 1-second GOP; proxy is still generated.

### 2.5 Synthetic cursor
`SCStreamConfiguration.showsCursor = false`. Captured pixels contain no cursor. It is composited at export time from the telemetry track — this makes smoothing, click ripples, size scaling, and styling possible, and keeps the cursor sharp when zoomed.

---

## 3. Data contracts
Freeze at M2.

### 3.1 Project bundle
A directory `.dolly`, opaque to Finder (`LSTypeIsPackage`).

```
Session 2026-07-26 14.03.dolly/
  project.json
  master.mov          # or master.mp4
  proxy.mp4
  audio-system.m4a    # optional, AAC 48kHz
  audio-mic.m4a       # optional
  cursor.jsonl
  thumb.jpg
```

Audio is kept out of the video container so the user can mute/re-balance at export without a capture-time re-encode decision.

### 3.2 `cursor.jsonl`
One JSON object per line, appended during capture, flushed every 500ms. Timestamps are **seconds, floating point, relative to the presentation timestamp of the first written video frame**.

```jsonc
{"t":0.000,"x":0.4821,"y":0.3310,"e":"move"}
{"t":0.512,"x":0.4830,"y":0.3312,"e":"down","b":"left"}
{"t":0.598,"x":0.4830,"y":0.3312,"e":"up","b":"left"}
{"t":1.204,"x":0.6610,"y":0.2044,"e":"scroll","dy":-3.0}
{"t":2.910,"e":"key"}
```

- `x`, `y` normalized `[0,1]` against the **captured surface**, origin top-left. Convert from AppKit's bottom-left origin at write time.
- `e` ∈ `move | down | up | drag | scroll | key`.
- `key` events carry no keycode — typing *rhythm* only, never content. Not a keylogger.
- Move events throttled to 120Hz, deduplicated when displacement < 0.001.

### 3.3 `project.json`
See `packages/schema/schema/project.schema.json` for the authoritative schema. Example:

```jsonc
{
  "version": 1,
  "source": { "master": "master.mov", "proxy": "proxy.mp4",
              "width": 3456, "height": 2160, "fps": 60, "duration": 187.4, "scale": 2.0 },
  "audio": [ {"file":"audio-system.m4a","role":"system","gain":1.0,"muted":false},
             {"file":"audio-mic.m4a","role":"mic","gain":1.2,"muted":false} ],
  "trim": { "in": 2.15, "out": 176.80 },
  "composition": {
    "backdrop": {"type":"gradient","from":"#2A3138","to":"#151A1F","angle":135},
    "padding": 0.06, "radius": 12,
    "shadow": {"enabled":true,"opacity":0.45,"blur":48,"y":14}
  },
  "cursor": { "visible": true, "size": 1.0, "smoothing": 0.35, "clickRipple": true, "hideWhenIdle": 2.0 },
  "zooms": [
    { "id":"z1","start":12.40,"end":17.10,"scale":2.2,
      "focal":{"mode":"fixed","x":0.31,"y":0.62},
      "rampIn":0.45,"rampOut":0.60,"easing":"cubicInOut","origin":"auto" },
    { "id":"z2","start":44.00,"end":51.30,"scale":1.8,
      "focal":{"mode":"follow","damping":0.12,"track":"cursor"},
      "rampIn":0.45,"rampOut":0.60,"easing":"cubicInOut","origin":"manual" }
  ],
  "speed": [],
  "autoZoom": { "lastRunParams": {}, "generatedAt": "2026-07-26T18:12:04Z" }
}
```

`origin` distinguishes auto-generated segments from user-authored ones. Re-running auto-zoom replaces `origin:"auto"` segments and leaves `"manual"` untouched. A user edit to an auto segment flips it to `"manual"`.

### 3.4 Sidecar protocol
Requests on stdin, one JSON object per line:

```jsonc
{"id":1,"cmd":"listSources"}
{"id":2,"cmd":"start","target":{"kind":"window","id":4213},
 "quality":"studio","mic":"BuiltInMicrophoneDevice","systemAudio":true,
 "out":"/Users/g/Movies/Session.dolly"}
{"id":3,"cmd":"stop"}
{"id":4,"cmd":"export","project":"/path/project.json","out":"/path/out.mp4","preset":"h264-1080p"}
```

Responses and events on stdout:

```jsonc
{"id":1,"ok":true,"displays":[...],"windows":[...]}
{"ev":"recording","t":12.4,"dropped":0}
{"ev":"exportProgress","p":0.42,"fps":118}
{"id":4,"ok":true,"path":"/path/out.mp4","bytes":48211944}
{"ev":"error","code":"tcc.screenRecording.denied","msg":"..."}
```

stderr is a plain text log, forwarded to the app's log file, never parsed.

---

## 4. Repository layout

```
dolly/
  apps/desktop/                 # Tauri app
    src/                        # React + TS frontend
      editor/  preview/  state/  ipc/
    src-tauri/
      src/main.rs  src/sidecar.rs  src/projects.rs
      tauri.conf.json  entitlements.plist
  native/dollyd/                # Swift package -> single executable
    Sources/dollyd/
      main.swift
      Capture/{SCRecorder,AudioTap,EventMonitor,ClockSync}.swift
      Export/{Renderer,Exporter}.swift
      Model/Project.swift
  packages/autozoom/            # TypeScript, pure functions, no I/O
  packages/schema/              # JSON Schema + generated TS & Swift types
  scripts/{build-sidecar,sign-and-notarize}.sh
  .github/workflows/release.yml
```

`packages/schema` is the source of truth; generate TS types and Swift `Codable` structs from it in CI. `packages/autozoom` is a pure TS library with no filesystem/DOM access, unit-tested against recorded fixtures.

---

## 5. Capture subsystem

### 5.1 Source enumeration
`SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)`. Return displays and windows with `windowID`, owning app name, title, frame, thumbnail. Filter windows < 80×80 and windows owned by DOLLY. For region capture, present a borderless overlay `NSWindow` at `.screenSaver` level for the drag, then a display filter plus `SCStreamConfiguration.sourceRect`.

### 5.2 Stream configuration
```swift
cfg.width  = Int(target.width  * scale)   // backing scale, not points
cfg.height = Int(target.height * scale)
cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
cfg.pixelFormat = kCVPixelFormatType_32BGRA
cfg.showsCursor = false
cfg.queueDepth = 8
cfg.capturesAudio = true
cfg.excludesCurrentProcessAudio = true
cfg.colorSpaceName = CGColorSpace.sRGB   // pin explicitly; P3 without pinning desaturates
```
Handle `stream(_:didStopWithError:)` — display reconfiguration, target window closing, display sleep. On window-target loss, stop cleanly and keep footage.

### 5.3 Clock synchronization — read this twice
Load-bearing. Cursor and video timestamps disagreeing by even 100ms makes auto-zoom land wrong.

- `CMSampleBuffer` PTS from `SCStream` are on `CMClockGetHostTimeClock()`.
- `NSEvent.timestamp` is seconds since boot (same base as `mach_absolute_time()` scaled by `mach_timebase_info`).

Procedure:
1. On the first video sample buffer committed to the writer, record `t0 = CMSampleBufferGetPresentationTimeStamp(sb)` converted to seconds on the host clock.
2. For each event, `eventT = NSEvent.timestamp`.
3. Write `t = eventT - t0`. Drop events with `t < 0`.
4. Never use `Date()` or `CACurrentMediaTime()` in this path.

**Acceptance test:** a fixture app flashes the screen white and synthesizes a click at the same runloop turn, ten times over 30 seconds. Detect the flash by scanning decoded frame luminance; compare its timestamp to the `down` event's `t`. Require |Δ| < 16ms for all ten.

### 5.4 Event monitoring and permissions
Use `NSEvent` monitors, not `CGEventTap`. Install **both** a global and a local monitor.

| Capability | Permission | Prompt |
|---|---|---|
| Screen capture | Screen Recording (TCC) | `CGRequestScreenCaptureAccess()` |
| Mouse position + clicks | none | — |
| Keystroke *timing* | Input Monitoring | `CGRequestListenEventAccess()` |

Verify the middle row on clean macOS 14 and 15 VMs. Keystroke timing is marginal (§6.4 weights it lowest) — make it an opt-in toggle "Detect typing for smarter zooms," off by default, so the app requires exactly one permission out of the box.

### 5.5 Writers
- Master video: ProRes 422 LT or H.264 (`AVVideoMaxKeyFrameIntervalKey = fps`) for Quick.
- Proxy video: H.264, 1280px wide, `AVVideoMaxKeyFrameIntervalKey = 15`, `AVVideoAverageBitRateKey ≈ 4_000_000`. Downscale via `vImage`/`CIContext`; reuse a `CVPixelBufferPool`.
- Audio: system audio from `SCStream`, mic from `AVCaptureSession`, two AAC files.

Backpressure: if `isReadyForMoreMediaData` is false, drop the *proxy* frame, never the master; increment a counter surfaced in the `recording` event. Disk pre-flight: refuse below 10GB (ProRes 422 LT 4K60 ≈ 1.5–2 GB/min).

---

## 6. Editor and rendering

### 6.1 Frontend stack
React 18 + TypeScript + Vite. Zustand store. Undo/redo via **immer inverse patches**, cap 200. Timeline is DOM (absolutely positioned divs), not canvas.

### 6.2 Playback
`<video src="proxy.mp4">`, hidden, driven by `requestVideoFrameCallback`. Two `<audio>` elements for system/mic, resynced whenever `|audioEl.currentTime - videoEl.currentTime| > 0.05`.

### 6.3 Preview renderer
Per frame, in order: fill backdrop → compute content rect (inset by `padding × min(W,H)`, aspect-fit) → shadow rounded rect → clip rounded rect → zoom transform about focal → `drawImage` → synthetic cursor (scaled by `1/zoomScale`) → unclip, editor-only overlays (never in export).

Zoom transform (focal in source-normalized coords):
```
s  = scaleAt(t)
fx = clamp(focalX, 1/(2s), 1 - 1/(2s))
fy = clamp(focalY, 1/(2s), 1 - 1/(2s))
px = ix + fx*iw ; py = iy + fy*ih
cx = ix + iw/2 ; cy = iy + ih/2
translate(cx, cy); scale(s, s); translate(-px, -py)
```
Derive the clamp once, put it in `packages/schema` as a shared function, use the identical implementation in Swift.

`focal.mode == "fixed"`: interpolate scale across ramps with `cubicInOut`, hold focal. `focal.mode == "follow"`: drive the focal through a **critically damped spring** toward the smoothed cursor:
```
omega = 2*pi / damping
k     = 1 - exp(-omega*dt)
vel  += (target - pos) * k
pos  += vel * dt
vel  *= exp(-omega*dt)
```

### 6.4 Auto-zoom
`packages/autozoom`, pure/deterministic/no-I/O:
```ts
function generateZooms(cursor, meta: {duration, aspect}, params): Zoom[]
```

Parameters and defaults (do not invent):

| Param | Default | Meaning |
|---|---|---|
| `resampleHz` | 30 | resample grid |
| `minCutoff`/`beta` | 1.0 / 0.02 | One Euro filter constants |
| `mergeGap` | 1.2s | max time gap to join a cluster |
| `mergeRadius` | 0.18 | normalized diagonal distance, same cluster |
| `minDwell` | 0.6s | clusters shorter dropped unless they contain a click |
| `leadIn` | 0.35s | segment starts before first event |
| `tail` | 0.60s | segment ends after last event |
| `rampIn`/`rampOut` | 0.45s / 0.60s | ease durations |
| `minGap` | 1.5s | min quiet time between segments |
| `scaleRange` | [1.4, 2.4] | mapped from cluster spread |
| `maxCoverage` | 0.55 | fraction of trimmed duration that may be zoomed |
| `maxRate` | 1 per 4s | density ceiling |
| `followThreshold` | 0.25 | spread above which focal mode = follow |

Algorithm:
1. Resample moves to `resampleHz`; One Euro filter x,y; keep discrete events at exact timestamps.
2. Score: `down`=1.0, `drag` end=0.8, `scroll` burst=0.5, `key` burst=0.4, dwell (stationary within 0.02 for >0.8s)=0.3. Bursts collapse to a single scored event at their midpoint.
3. Cluster: greedy single-pass — join open cluster if `Δt < mergeGap` **and** distance to centroid `< mergeRadius`.
4. Filter: drop clusters with total score < 0.5, or duration < `minDwell` and no click.
5. Emit per cluster: `start = first.t - leadIn`, `end = last.t + tail`; `focal` = **spatial median** of member points; `spread` = MAD normalized to diagonal; `scale` = linear map of spread `[0.02,0.30]` onto `scaleRange` reversed, clamped; `focal.mode = spread > followThreshold ? "follow" : "fixed"`.
6. Resolve conflicts: on overlap after ramps, merge if focal distance `< mergeRadius`, else truncate earlier tail until `minGap`; if that shortens below `minDwell`, drop the lower-scoring one.
7. Budget: while coverage `> maxCoverage` or local rate `> maxRate`, drop the lowest-scoring segment. **Do not skip this step.**
8. Emit with `origin:"auto"`.

Six committed fixtures (form fill, code editing, dashboard walkthrough, fast tab-switching, idle, chaotic waving) with hand-labeled expected counts and focal targets. Assert count within ±1, focal within 0.08 normalized distance.

UI: runs automatically once when recording finishes; "Added N zooms — Adjust · Regenerate · Clear." Only three user controls — intensity (scales `maxCoverage` + `scaleRange`), smoothness (scales ramps + `damping`), "zoom on clicks only" (drops scroll/key/dwell scoring). Full param table in a debug panel.

### 6.5 Synthetic cursor
Render from telemetry, identically in preview and export: One Euro filtered position + §6.3 spring smoothing; bundled SVG arrow/I-beam paths (not the 24px system bitmap); scale `cursor.size × (1/zoomScale)`; click ripple (expanding ring, 350ms, `cubicOut`, opacity 0.5→0); `hideWhenIdle` fade.

### 6.6 Export
`AVAssetReader` on `master.mov` → per-frame `CVPixelBuffer` → composition → `AVAssetWriter`. Audio mixed with `AVMutableAudioMix` (per-track gain/mute). Composition in Core Image: `CILinearGradient` → `CIAffineTransform` → `CIBlendWithMask` (rounded-rect) → shadow via `CIGaussianBlur` → cursor drawn into a `CIImage`. Render with `CIContext(mtlDevice:)` into the writer's pool. Metal single-pass fallback if CI can't hold 60fps at 4K.

Presets: `h264-1080p`, `h264-4k`, `hevc-4k`, `gif-720p`. Always `AVVideoProfileLevelH264HighAutoLevel`, `kVTCompressionPropertyKey_AllowFrameReordering = true` unless streamable.

**Parity test:** for each of three fixture projects, pick 12 timestamps (including mid-ramp), render each through export → PNG and through a headless preview harness → PNG; assert mean absolute pixel difference < 2/255, no single pixel differing by more than 12/255. Wire into CI.

---

## 7. Milestones
M0 Scaffold · M1 Naive capture · M2 Real capture + telemetry (freeze §3 schemas) · M3 Editor shell · M4 Manual zooms · M5 Auto-zoom · M6 Export · M7 Ship. ~32 working days; +40% if the Metal fallback is needed. Each milestone is a vertical slice that runs.

---

## 8. Packaging and distribution
Developer ID Application cert, hardened runtime on. Entitlements: `com.apple.security.device.audio-input`; **no** `com.apple.security.app-sandbox` for v1. `Info.plist`: `NSMicrophoneUsageDescription` (+`NSCameraUsageDescription` if camera lands in v1.1). **Sign the sidecar first, then the app** (`codesign --deep` is unreliable). Notarize with `xcrun notarytool submit --wait`, `xcrun stapler staple`, verify `spctl -a -vvv -t install`. Universal binary via `lipo`; Tauri `--target universal-apple-darwin`. Updates via Tauri updater against a static JSON manifest, signed with the updater's own key. Distribute a notarized DMG.

---

## 9. Risks
Clock skew (§5.3 test on every CI build) · preview/export divergence (§6.6 parity, shared math from schema) · WKWebView scrubbing (drop proxy to 960px, else Electron) · mouse monitoring needing Input Monitoring (verify at M2) · ProRes disk consumption (pre-flight + Quick default) · Core Image too slow (Metal single-pass) · macOS releases breaking ScreenCaptureKit (sidecar isolation + beta smoke test) · auto-zoom chaos (§6.4 step 7 budget + fixture suite).

---

## 10. Notes for the executing agent
Build M0–M2 before writing editor UI. The three tests that matter are §5.3, §6.4, §6.6 — write them with their milestone. When a §2 decision turns out wrong, write down the evidence before changing it. Resist adding a share link.
