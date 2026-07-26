/**
 * Step 2 of the auto-zoom pipeline (BUILD_PLAN §6.4): turn the raw event stream into scored
 * "interest" events. Bursts of scroll/key collapse to a single scored event at their
 * midpoint; dwell is detected on the filtered track.
 */
import type { CursorEvent } from "@dolly/schema";
import type { Sample } from "./track.js";

export interface ScoredEvent {
  t: number;
  x: number;
  y: number;
  score: number;
  /** true if this scored event is (or contains) a mouse-down click */
  click: boolean;
  kind: "down" | "drag" | "scroll" | "key" | "dwell";
}

const SCORE = {
  down: 1.0,
  dragEnd: 0.8,
  scrollBurst: 0.5,
  keyBurst: 0.4,
  dwell: 0.3,
} as const;

/** Gap (seconds) within which consecutive scroll/key events are treated as one burst. */
const BURST_GAP = 0.6;
/** Dwell detection: cursor stationary within this radius for at least DWELL_MIN seconds. */
const DWELL_RADIUS = 0.02;
const DWELL_MIN = 0.8;

export interface ScoreOptions {
  /** clicks-only mode drops scroll/key/dwell scoring (BUILD_PLAN §6.4 UI toggle) */
  clicksOnly: boolean;
}

export function scoreEvents(
  events: CursorEvent[],
  samples: Sample[],
  sample: (t: number) => Sample,
  opts: ScoreOptions,
): ScoredEvent[] {
  const scored: ScoredEvent[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);

  // --- clicks and drags (always scored) ---
  // A drag is leftMouseDragged between a down and its up; we score the drag *end* (the up
  // that follows drag events). A plain down/up with no dragging scores as a down click.
  let draggingSince: number | null = null;
  for (const e of sorted) {
    // Discrete pointer events carry their own accurate position; use it directly. The
    // filtered track lags the true cursor and would pull the focal off the real target.
    const p = typeof e.x === "number" && typeof e.y === "number" ? { x: e.x, y: e.y } : sample(e.t);
    if (e.e === "down") {
      scored.push({ t: e.t, x: p.x, y: p.y, score: SCORE.down, click: true, kind: "down" });
      draggingSince = null;
    } else if (e.e === "drag") {
      if (draggingSince === null) draggingSince = e.t;
    } else if (e.e === "up") {
      if (draggingSince !== null) {
        scored.push({ t: e.t, x: p.x, y: p.y, score: SCORE.dragEnd, click: true, kind: "drag" });
        draggingSince = null;
      }
      // a plain up (no preceding drag) adds nothing beyond its down
    }
  }

  if (!opts.clicksOnly) {
    // --- scroll bursts ---
    collapseBursts(
      sorted.filter((e) => e.e === "scroll"),
      sample,
      SCORE.scrollBurst,
      "scroll",
      scored,
    );
    // --- key bursts ---
    collapseBursts(
      sorted.filter((e) => e.e === "key"),
      sample,
      SCORE.keyBurst,
      "key",
      scored,
    );
    // --- dwell ---
    scored.push(...detectDwell(samples));
  }

  return scored.sort((a, b) => a.t - b.t);
}

function collapseBursts(
  evts: CursorEvent[],
  sample: (t: number) => Sample,
  score: number,
  kind: "scroll" | "key",
  out: ScoredEvent[],
): void {
  if (evts.length === 0) return;
  let startT = evts[0]!.t;
  let lastT = evts[0]!.t;
  const flush = () => {
    const mid = (startT + lastT) / 2;
    const p = sample(mid);
    out.push({ t: mid, x: p.x, y: p.y, score, click: false, kind });
  };
  for (let i = 1; i < evts.length; i++) {
    const t = evts[i]!.t;
    if (t - lastT > BURST_GAP) {
      flush();
      startT = t;
    }
    lastT = t;
  }
  flush();
}

function detectDwell(samples: Sample[]): ScoredEvent[] {
  const out: ScoredEvent[] = [];
  if (samples.length === 0) return out;
  let anchor = samples[0]!;
  let startIdx = 0;
  const emit = (endIdx: number) => {
    const start = samples[startIdx]!;
    const end = samples[endIdx]!;
    if (end.t - start.t >= DWELL_MIN) {
      const mid = samples[(startIdx + endIdx) >> 1]!;
      out.push({ t: mid.t, x: mid.x, y: mid.y, score: SCORE.dwell, click: false, kind: "dwell" });
    }
  };
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    const dx = s.x - anchor.x;
    const dy = s.y - anchor.y;
    if (Math.sqrt(dx * dx + dy * dy) > DWELL_RADIUS) {
      emit(i - 1);
      anchor = s;
      startIdx = i;
    }
  }
  emit(samples.length - 1);
  return out;
}
