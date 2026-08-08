/**
 * Derive a smooth "watch mode" cursor path from a walkthrough's steps, reusing the
 * @dolly/cursoropt path optimizer. We drive it with an explicit beat plan (one beat per step)
 * so the cursor visits EVERY target — not just the salient click clusters the auto extractor
 * would keep. Pure and deterministic.
 */
import type { CursorEvent, CursorPath, Step } from "@dolly/schema";
import { optimizeCursor, DEFAULT_PARAMS, type BeatPlan } from "@dolly/cursoropt";

const EMPTY: CursorPath = { origin: "auto", mode: "pathClicks", keyframes: [], clicks: [] };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isClick(a: Step["action"]): boolean {
  return a === "click" || a === "dblclick" || a === "submit";
}

export interface BuildPathOptions {
  viewport: { w: number; h: number };
}

/**
 * Convert step target centers into an explicit beat plan, then optimize it into a clean path the
 * synthetic cursor follows between elements during "watch" playback.
 */
export function buildTutorialPath(steps: Step[], opts: BuildPathOptions): CursorPath {
  const withRects = steps.filter((s) => s.rect);
  if (withRects.length === 0) return EMPTY;

  const plan: BeatPlan = {
    source: "local",
    beats: withRects.map((s) => ({
      x: clamp01(s.rect!.x + s.rect!.w / 2),
      y: clamp01(s.rect!.y + s.rect!.h / 2),
      t: s.t,
      click: isClick(s.action),
    })),
  };

  // A non-empty cursor track is required so the optimizer doesn't early-return; the beat plan
  // (not the track) drives the waypoints.
  const events: CursorEvent[] = withRects.map((s) => ({
    t: s.t,
    x: clamp01(s.rect!.x + s.rect!.w / 2),
    y: clamp01(s.rect!.y + s.rect!.h / 2),
    e: "move",
  }));

  const duration = (steps[steps.length - 1]?.t ?? 0) + 1;
  const aspect = (opts.viewport.w || 16) / (opts.viewport.h || 9);
  return optimizeCursor(events, { duration, aspect }, DEFAULT_PARAMS, plan).cursorPath;
}
