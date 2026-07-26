/**
 * Step 1 of the auto-zoom pipeline (BUILD_PLAN §6.4): resample the cursor to a fixed grid
 * and remove jitter with a One Euro filter, producing a smoothed, uniformly-sampled position
 * track. Discrete events (down/up/scroll/key) are handled separately by `score.ts` and keep
 * their exact timestamps.
 */
import { OneEuroFilter } from "@dolly/schema";
import type { CursorEvent } from "@dolly/schema";

export interface Sample {
  t: number;
  x: number;
  y: number;
}

/** A positioned event: any cursor event that carries x/y (everything except bare `key`). */
function hasPos(e: CursorEvent): e is CursorEvent & { x: number; y: number } {
  return typeof e.x === "number" && typeof e.y === "number";
}

/**
 * Build a piecewise-linear position sampler from the raw events. Used both to resample onto
 * the grid and to look up a position for events that lack one (e.g. `key`).
 */
export function positionSampler(events: CursorEvent[]): (t: number) => Sample {
  const pts = events.filter(hasPos).sort((a, b) => a.t - b.t);
  return (t: number): Sample => {
    if (pts.length === 0) return { t, x: 0.5, y: 0.5 };
    if (t <= pts[0]!.t) return { t, x: pts[0]!.x, y: pts[0]!.y };
    if (t >= pts[pts.length - 1]!.t) {
      const last = pts[pts.length - 1]!;
      return { t, x: last.x, y: last.y };
    }
    // binary search for the segment containing t
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = pts[lo]!;
    const b = pts[hi]!;
    const span = b.t - a.t || 1;
    const f = (t - a.t) / span;
    return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
}

/**
 * Resample onto a uniform `resampleHz` grid over [0, duration] and One Euro filter each axis.
 * Returns the smoothed samples plus the sampler over the *filtered* track for downstream
 * dwell detection and position lookup.
 */
export function resampleAndFilter(
  events: CursorEvent[],
  duration: number,
  resampleHz: number,
  minCutoff: number,
  beta: number,
): { samples: Sample[]; sample: (t: number) => Sample } {
  const raw = positionSampler(events);
  const dt = 1 / resampleHz;
  const fx = new OneEuroFilter(minCutoff, beta);
  const fy = new OneEuroFilter(minCutoff, beta);
  const samples: Sample[] = [];
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    const p = raw(t);
    samples.push({ t, x: fx.filter(p.x, t), y: fy.filter(p.y, t) });
  }
  const sample = positionSampler(
    samples.map((s) => ({ t: s.t, x: s.x, y: s.y, e: "move" as const })),
  );
  return { samples, sample };
}
