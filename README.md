# DOLLY

**DOM-aware, self-healing product walkthroughs in the browser.** No native app, no server,
no account.

An author records a click-through of any web app with the DOLLY Chrome extension. Viewers can
then **watch it as a video with a rendered cursor**, *or* press play and have the walkthrough
**performed live in their own browser** — the synthetic cursor moves to each element, spotlights
it, and either does the action for them (*auto-run*) or coaches them to do it (*coach*).

Recordings are **DOM-aware**: every step captures *which element* was acted on with a ranked set
of resilient locators, so replay is **self-healing** — it still finds the target when the page
drifts (renamed ids, changed classes, moved or re-worded elements). Product teams embed the whole
thing with a single web component; **end users need no extension**.

## How it works

```
 AUTHOR (Chrome extension)                    VIEWER (any product page, no extension)
 ┌───────────────────────────┐                ┌────────────────────────────────────────┐
 │ content: DOM recorder + HUD│── Step[] ┐     │  <dolly-walkthrough recording=…>        │
 │ background: tabCapture→webm│          │     │   ├ WATCH: video + synthetic cursor      │
 │ popup: review / annotate   │          ▼     │   └ LIVE:  selector.resolve() → self-heal│
 └───────────────────────────┘   Recording{    │            → cursor.moveTo → spotlight    │
                                  steps, video, │            → auto-run | coach            │
                                  cursorPath}   └────────────────────────────────────────┘
                                        │
                                 export JSON (+webm) ────────────►  embed in product
```

## Architecture at a glance

| Component | Package | Role |
|---|---|---|
| Recording format | `packages/schema` | `Recording` / `Step` / `LocatorSet` types + JSON Schema; shared render math (Catmull-Rom, springs, easing) |
| **Self-healing locators** | `packages/selector` | generate ranked locators for an element; resolve them against a drifted DOM, healing by weighted candidate scoring |
| DOM recorder | `packages/recorder` | map DOM events → `Step`, masking password / autocomplete / `[data-dolly-secret]` values |
| Synthetic cursor | `packages/cursor` | click-through canvas overlay (cursor glyph, ripple, spotlight) + a smooth path between step targets |
| Embeddable player | `packages/player` | `<dolly-walkthrough>` web component: watch mode + live driver (auto-run / coach) |
| Zoom / path polish | `packages/autozoom`, `packages/cursoropt` | reused to route the watch-mode cursor cleanly through every target |
| Authoring extension | `apps/extension` | MV3: content recorder, tabCapture service worker, React popup step editor + export |
| Integration demo | `apps/demo` | a mock product page embedding the player, with an integration test that drives a real DOM |

## Building

Everything is browser TypeScript — it builds and tests on any OS.

```sh
pnpm install
pnpm -r build       # all packages + both apps (extension & demo vite-build to dist/)
pnpm -r typecheck
pnpm -r test        # selector self-heal, recorder+masking, schema, cursor, player, demo integration
```

Load the unpacked extension from `apps/extension/dist/` (Chrome → Extensions → Developer mode →
Load unpacked). Serve the demo with `pnpm --filter @dolly/demo dev`.

## The tests that matter

1. **Self-healing** (`packages/selector/test`) — before/after DOM-drift fixtures (renamed id,
   changed class, wrapped node, edited text, moved element, added/removed attr) assert the resolver
   still finds the target, and that structural reordering can't hijack a match.
2. **Recorder + masking** (`packages/recorder/test`) — event→step mapping never emits secret
   values; only navigation keystrokes are recorded.
3. **Integration** (`apps/demo/test`) — a `Recording` built from the demo's real markup drives that
   form to the expected state through the player, **and still does so after the page's ids/test-ids
   drift** — proving the end-to-end embed.

## Live replay — safety

Auto-run dispatches real actions in the viewer's page, so DOLLY holds back the dangerous ones:

- Steps flagged **destructive** are **coached, never auto-run** (the viewer performs them).
- A visible **"DOLLY is driving"** banner shows during auto-run, and playback is abortable.
- **Masked** inputs (passwords, secrets) never carry a value — DOLLY pauses and asks the viewer to
  type their own.

## Status

The libraries and the integration are implemented and unit-tested on Linux (selector, recorder,
schema, cursor, player driver, and the demo integration all run green). The MV3 extension and the
demo vite-build into loadable output. Full in-browser QA — loading the unpacked extension,
recording on a live site, and replaying auto-run/coach against real DOM drift — is a manual browser
step on top of the covered logic.
