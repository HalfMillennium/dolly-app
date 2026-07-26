# DOLLY

Local-first macOS screen recorder with cursor-driven auto-zoom. No server, no account.

DOLLY captures a display, window, or region at up to 4K60 with system audio and mic on
separate tracks, records a cursor telemetry track in the same clock domain as the video,
and derives editable zoom segments from cursor motion automatically. Editing is
non-destructive; export is native and faster than real time.

See the full technical build plan in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Architecture at a glance

| Component | Tech | Role |
|---|---|---|
| Shell | Tauri v2 (Rust + WKWebView) | app lifecycle, sidecar supervision, project bundle I/O |
| Capture / export | Swift sidecar `dollyd` | ScreenCaptureKit + AVFoundation, spoken to over NDJSON on stdio |
| Editor UI | React 18 + TypeScript + Vite | timeline, inspector, canvas preview |
| Auto-zoom | pure TypeScript (`packages/autozoom`) | derives zoom segments from cursor telemetry |
| Contracts | JSON Schema (`packages/schema`) | source of truth for `project.json` + `cursor.jsonl`, codegen'd to TS & Swift |

## Repository layout

```
dolly/
  apps/desktop/          # Tauri app (React frontend + Rust shell)
  native/dollyd/         # Swift package -> single capture/export executable
  packages/autozoom/     # pure TS auto-zoom library (no I/O, fixture-tested)
  packages/schema/       # JSON Schema + generated TS & Swift types + shared math
  scripts/               # build-sidecar, sign-and-notarize
  .github/workflows/     # CI + release
```

## Building

DOLLY ships on macOS only. This repository is a monorepo; the platform-independent layers
(`packages/*`) build and test on any OS, while the native app requires macOS + Xcode.

### Platform-independent (any OS)

```sh
pnpm install
pnpm -r build      # compile packages/schema and packages/autozoom
pnpm -r test       # run the TS test suites (auto-zoom fixture suite, shared-math tests)
```

### Full macOS app

See [`MAC_BUILD.md`](MAC_BUILD.md) for the complete Xcode/Tauri/signing checklist. In short:

```sh
scripts/build-sidecar.sh                       # swift build + lipo universal dollyd
pnpm --filter desktop tauri build --target universal-apple-darwin
scripts/sign-and-notarize.sh                   # sign sidecar, then app; notarize; staple
```

## The three tests that matter

1. **Clock sync** (`native/dollyd/Tests/.../ClockSyncTests.swift`) — cursor vs. video
   timebase agreement within one frame. macOS-only.
2. **Auto-zoom fixtures** (`packages/autozoom/test`) — regression suite over hand-labeled
   cursor traces. Runs anywhere.
3. **Render parity** (`native/dollyd/Tests/.../ParityTests.swift`) — export path must match
   the preview path pixel-for-pixel. macOS-only.

## Status

This is a scaffold-complete first pass. The pure-TS core (`packages/schema`,
`packages/autozoom`) is implemented and tested. The native tree (`native/dollyd`,
`apps/desktop/src-tauri`) and the React editor are written and awaiting a macOS build —
every deferred step is marked `TODO(mac)` and enumerated in `MAC_BUILD.md`.
