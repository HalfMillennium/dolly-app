# Building DOLLY on macOS

This repository was scaffolded headless on Linux, where the pure-TypeScript core
(`packages/schema`, `packages/autozoom`) is fully implemented and tested, but the native
layers — the Swift `dollyd` sidecar, the Tauri Rust shell, and the two native tests — cannot
be compiled or run. This checklist takes the draft to a running, signed `.app` on macOS.

Every step below corresponds to code already written in the repo; the remaining work is
compiling it, wiring device permissions, and fixing whatever the compiler and real hardware
surface. Search the tree for `TODO(mac):` to find each spot that needs on-device attention.

## 0. Prerequisites

- macOS 14 or 15, Xcode 15+ (`xcode-select --install` for the CLI tools at minimum, full
  Xcode for the frameworks/signing).
- Node 22 + `pnpm` 10, Rust stable with the two Apple targets:
  `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- `cargo install tauri-cli --version '^2'` (or use the workspace `pnpm --filter desktop tauri`).
- An Apple Developer account with a **Developer ID Application** certificate (for the DMG),
  and an app-specific password for `notarytool`.

## 1. Verify the TS core (sanity, works on any OS)

```sh
pnpm install
pnpm -r build
pnpm -r test        # schema math (25) + auto-zoom fixtures (26) must be green
```

## 2. Build the Swift sidecar

```sh
swift build --package-path native/dollyd            # debug compile first — fix TODO(mac) gaps
scripts/build-sidecar.sh release                    # universal binary -> src-tauri/binaries/
```

Expect the first compile to need attention on: ScreenCaptureKit availability annotations,
`SCStreamConfiguration.captureResolution`/`sourceRect` specifics, and the exact
`AVAssetWriterInput` codec keys for ProRes 422 LT vs. H.264 all-intra (§5.5). The
`RenderMath.swift` port must stay numerically identical to `packages/schema/src/math.ts`.

## 3. Run the two native tests — the load-bearing ones (§10)

```sh
swift test --package-path native/dollyd
```

- **`ClockSyncTests`** (§5.3): the white-flash/synthetic-click acceptance test. Requires
  Screen Recording permission for the test runner and UI-event synthesis entitlement; the
  `TODO(mac):` markers flag the automation glue. Requirement: `|Δ| < 16 ms` for all ten
  trials across 30 s. If it fails, the timebase conversion in `ClockSync.swift` is wrong —
  do not proceed until it is green.
- **`ParityTests`** (§6.6): renders 12 timestamps per fixture project through the export
  `Renderer` and compares to preview PNGs. Wire the preview side to the headless harness
  (`scripts/parity/`, see its README) so both renderers are driven by the same `project.json`.
  Requirement: mean-abs pixel diff `< 2/255`, no pixel `> 12/255`.

## 4. Verify permissions on clean VMs (§5.4 — do this before onboarding design)

On clean macOS 14 **and** 15 VMs, confirm the middle row of the §5.4 table: **mouse position +
clicks require no permission**. If mouse monitoring turns out to need Input Monitoring, the
onboarding flow changes (auto-zoom becomes a second-run opt-in) — record the finding in
`docs/BUILD_PLAN.md` before reworking onboarding. Keystroke *timing* stays an opt-in toggle,
off by default, so the app asks for exactly one permission (Screen Recording) out of the box.

## 5. Build the app

```sh
pnpm --filter desktop build                          # frontend (also runs on Linux)
pnpm --filter desktop tauri build --target universal-apple-darwin
```

## 6. Freeze the schemas (at M2) and regenerate types

Once real capture confirms the field set, run codegen so TS and Swift models come from one
source (`packages/schema`, §4):

```sh
pnpm --filter @dolly/schema gen                      # gen-ts.ts + gen-swift.sh (needs quicktype)
```

## 7. Sign, notarize, staple (§8)

```sh
export DEV_ID_APP="Developer ID Application: <You> (<TEAMID>)"
export APP_PATH="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/DOLLY.app"
xcrun notarytool store-credentials dolly-notary --apple-id <id> --team-id <team> --password <app-pw>
export NOTARY_PROFILE=dolly-notary
scripts/sign-and-notarize.sh                         # signs sidecar FIRST, then app; notarizes; staples; spctl
```

In CI this is `.github/workflows/release.yml`, driven entirely by repository secrets.

## 8. Definition of done (§1)

A stranger on a clean machine downloads the notarized DMG, opens it, grants **one** permission
(Screen Recording), records a 5-minute Chrome session, gets sensible auto-zooms untouched,
adjusts two of them, and exports a 1080p MP4 in under half the recording's duration.

---

## Map of what still needs a Mac (TODO(mac) index)

| Area | File(s) | What's deferred |
|---|---|---|
| Capture stream | `native/dollyd/Sources/dollyd/Capture/SCRecorder.swift` | ScreenCaptureKit compile + live capture, `didStopWithError` handling |
| Clock sync | `.../Capture/ClockSync.swift` | host-clock `t0`, `NSEvent.timestamp` base — verified by `ClockSyncTests` |
| Event monitor | `.../Capture/EventMonitor.swift` | global+local `NSEvent` monitors, permission prompts |
| Writers | `.../Capture/Writers.swift`, `AudioTap.swift` | ProRes/H.264 dual-write, AAC audio, `CVPixelBufferPool`, backpressure |
| Export | `.../Export/Renderer.swift`, `Exporter.swift` | Core Image chain, `CIContext(mtlDevice:)`, presets; Metal fallback if CI < 60fps @4K |
| Parity | `.../Tests/dollydTests/ParityTests.swift`, `scripts/parity/` | headless preview harness, cross-language PNG diff |
| Shell | `apps/desktop/src-tauri/**` | `cargo check`/`tauri build` (needs webkit + macOS), sidecar supervision live |
| Signing | `scripts/sign-and-notarize.sh`, `.github/workflows/release.yml` | real Developer ID cert + notarytool credentials |
| Cursorcraft — director | `apps/desktop/src-tauri/src/director.rs` | OS-keychain read of the Claude key + live Messages API call (`reqwest`); wire a Settings UI to store the key |
| Cursorcraft — export | `.../Export/Renderer.swift` | compile the optimized-cursor position source (shared `catmullRomAt` over `cursorPath.keyframes` + click-mark ripples) |
| Cursorcraft — parity | `.../Tests/dollydTests/ParityTests.swift`, `scripts/parity/` | add the `cursorcraft` fixture (project.json with a `cursorPath`) and render its preview PNGs with `showOptimized: true` |

## Cursorcraft (AI-optimized cursor) — status

The platform-independent core is done and tested on Linux: `packages/cursoropt` (the pure
optimizer, 33 tests) and the shared `catmullRom`/`catmullRomAt` spline in `packages/schema`
(+ its `RenderMath.swift` mirror). The React editor wiring type-checks and vite-builds. What
remains for the Mac pass is the three rows above — compile the Swift export path, wire the
optional Claude director (key storage + live call), and add the `cursorcraft` parity fixture so
the exported MP4 is proven pixel-identical to the preview.
