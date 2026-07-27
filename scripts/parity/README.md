# Render parity harness (§6.6)

The parity test is the most important test in the repo: it proves the **preview** renderer
(TypeScript canvas, `apps/desktop/src/preview`) and the **export** renderer (Swift Core
Image, `native/dollyd/Export`) produce the same pixels from the same `project.json`. Any
divergence is a bug in one of them, and without this test you cannot tell which.

## How it works

For each of three fixture projects, pick 12 timestamps — deliberately including mid-ramp
times, not just steady state — and for each timestamp:

1. **Export path** — `ParityTests.swift` renders the frame through the export `Renderer` to a
   PNG.
2. **Preview path** — `render-preview.ts` (this directory) drives the *same* preview renderer
   headlessly to a PNG, reading the identical `project.json`.
3. **Compare** — assert mean absolute pixel difference `< 2/255` and no single pixel
   differing by more than `12/255`.

Both renderers consume the shared math from `packages/schema` (`math.ts` in TS, its
`RenderMath.swift` port), which is what makes parity achievable in the first place.

A fourth fixture, **`cursorcraft`**, carries an AI-optimized `cursorPath` in its `project.json`
and is rendered with `showOptimized: true` on both sides, so the parity test also covers the
optimized cursor position source (shared `catmullRomAt` over keyframes + click-mark ripples) —
the Cursorcraft feature's preview/export contract.

## Status

`render-preview.ts` is a `TODO(mac)` skeleton. Running the preview renderer outside the
webview needs a canvas implementation (e.g. `skia-canvas`/`@napi-rs/canvas`) and a decoded
frame source for the proxy video; both are wired up during the M6 export milestone on macOS.
The Swift side (`ParityTests.swift`) and the shared math are already in place, so this harness
is the last mile.
