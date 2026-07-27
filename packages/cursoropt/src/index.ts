/**
 * DOLLY AI-optimized cursor ("Cursorcraft").
 *
 * `optimizeCursor` is pure and deterministic: same inputs -> same output, no filesystem, DOM,
 * clock, or randomness. It re-authors the recorded cursor telemetry into a clean, purposeful
 * path with well-timed clicks, emitted as a serializable `CursorPath` (BUILD_PLAN §3.3 addition)
 * that both the TS preview renderer and the Swift export renderer evaluate identically via the
 * shared Catmull-Rom math — so preview matches export (§6.6).
 *
 * The optional `beats` argument is the seam to the AI director (see beats.ts): when omitted, the
 * optimizer derives beats locally from the track (offline default); the LLM never runs here.
 */
import {
  OneEuroFilter,
  cubicInOut,
  type CursorEvent,
  type CursorPath,
  type ClickMark,
  type PathKey,
  type Zoom,
} from "@dolly/schema";
import {
  DEFAULT_PARAMS as AZ_DEFAULTS,
  resampleAndFilter,
  scoreEvents,
  clusterEvents,
  filterClusters,
  generateZooms,
  type GenerateMeta,
} from "@dolly/autozoom";
import {
  DEFAULT_PARAMS,
  paramsFromControls,
  type CursorOptParams,
  type CursorOptControls,
} from "./params.js";
import { localBeatProvider, type BeatPlan } from "./beats.js";

export {
  DEFAULT_PARAMS,
  DEFAULT_CONTROLS,
  paramsFromControls,
  type CursorOptParams,
  type CursorOptControls,
} from "./params.js";
export {
  localBeatProvider,
  type Beat,
  type BeatPlan,
  type BeatProvider,
  type BeatProviderInput,
} from "./beats.js";
export type { GenerateMeta } from "@dolly/autozoom";

export interface OptimizeResult {
  cursorPath: CursorPath;
  /** present only in "full" mode: auto-zoom segments re-timed to the optimized path */
  retimedZooms?: Zoom[];
}

interface Target {
  t: number;
  x: number;
  y: number;
  click: boolean;
  score: number;
}

interface Corner {
  t: number;
  x: number;
  y: number;
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Step 1: extract an ordered list of targets from the raw track (reuses @dolly/autozoom). */
function extractTargets(
  cursor: CursorEvent[],
  meta: GenerateMeta,
  params: CursorOptParams,
): { targets: Target[]; startX: number; startY: number } {
  const { samples, sample } = resampleAndFilter(
    cursor,
    meta.duration,
    params.resampleHz,
    params.minCutoff,
    params.beta,
  );
  const scored = scoreEvents(cursor, samples, sample, { clicksOnly: false });
  const clusters = filterClusters(clusterEvents(scored, AZ_DEFAULTS), AZ_DEFAULTS);
  const targets = clusters
    .map((c) => ({ t: c.firstT, x: c.centroidX, y: c.centroidY, click: c.hasClick, score: c.totalScore }))
    .sort((a, b) => a.t - b.t);
  const start = samples[0] ?? { x: 0.5, y: 0.5 };
  return { targets, startX: start.x, startY: start.y };
}

/** Build the piecewise corner list (arrival + hold corners) and the click marks. */
function buildCorners(
  plan: BeatPlan,
  params: CursorOptParams,
  startX: number,
  startY: number,
  duration: number,
): { corners: Corner[]; clicks: ClickMark[] } {
  const beats = [...plan.beats].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const corners: Corner[] = [{ t: 0, x: startX, y: startY }];
  const clicks: ClickMark[] = [];
  let lastT = 0;

  beats.forEach((b, i) => {
    const wantArrival = b.t ?? ((i + 1) / (beats.length + 1)) * duration;
    // guarantee a minimum travel window so the cursor never teleports
    const arrival = Math.max(wantArrival, lastT + params.minMove * params.speed);
    corners.push({ t: arrival, x: b.x, y: b.y });
    if (b.click) {
      // ripple fires just after the cursor lands on the target
      clicks.push({ t: round(arrival + 0.05), x: round(b.x), y: round(b.y), button: "left" });
    }
    const dwell = (b.dwell ?? params.dwell) * params.speed;
    const depart = Math.min(arrival + dwell, duration);
    if (depart > arrival) corners.push({ t: depart, x: b.x, y: b.y });
    lastT = depart;
  });
  return { corners, clicks };
}

/** Eased position on the corner path at time `t` (cubicInOut per move segment; hold is flat). */
function positionAt(corners: Corner[], t: number, straightness: number): { x: number; y: number } {
  const n = corners.length;
  if (n === 0) return { x: 0.5, y: 0.5 };
  if (t <= corners[0]!.t) return { x: corners[0]!.x, y: corners[0]!.y };
  const last = corners[n - 1]!;
  if (t >= last.t) return { x: last.x, y: last.y };

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (corners[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = corners[lo]!;
  const b = corners[hi]!;
  if (a.x === b.x && a.y === b.y) return { x: a.x, y: a.y }; // hold
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  const e = cubicInOut(f);
  let x = a.x + (b.x - a.x) * e;
  let y = a.y + (b.y - a.y) * e;
  // straightness < 1 bows the move outward (perpendicular to the segment) for a softer arc
  if (straightness < 1) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = (1 - straightness) * 0.06 * Math.sin(Math.PI * f);
    x += (-dy / len) * bow;
    y += (dx / len) * bow;
  }
  return { x, y };
}

/**
 * Re-author the cursor telemetry into an optimized path.
 *
 * @param cursor  parsed cursor.jsonl events
 * @param meta    media duration + aspect
 * @param params  full parameter set (defaults provided)
 * @param beats   optional director beat plan; defaults to the local (offline) provider
 */
export function optimizeCursor(
  cursor: CursorEvent[],
  meta: GenerateMeta,
  params: CursorOptParams = DEFAULT_PARAMS,
  beats?: BeatPlan,
): OptimizeResult {
  const empty: CursorPath = { origin: "auto", mode: params.mode, keyframes: [], clicks: [] };
  if (meta.duration <= 0 || cursor.length === 0) return { cursorPath: empty };

  const { targets, startX, startY } = extractTargets(cursor, meta, params);
  const plan =
    beats ??
    localBeatProvider({
      targets: targets.map((t) => ({ t: t.t, x: t.x, y: t.y, click: t.click, score: t.score })),
      duration: meta.duration,
    });
  if (plan.beats.length === 0) return { cursorPath: empty };

  const { corners, clicks } = buildCorners(plan, params, startX, startY, meta.duration);

  // Sample the eased corner path onto a uniform grid, then apply a gentle One Euro pass so the
  // motion reads as a smooth camera-like move. smoothness 0 -> light, 1 -> heavy.
  const dt = 1 / params.sampleHz;
  const outCutoff = 3.0 - params.smoothness * 2.4; // 3.0 (light) .. 0.6 (heavy)
  const fx = new OneEuroFilter(outCutoff, 0.01);
  const fy = new OneEuroFilter(outCutoff, 0.01);
  const keyframes: PathKey[] = [];
  for (let t = 0; t <= meta.duration + 1e-9; t += dt) {
    const p = positionAt(corners, t, params.straightness);
    keyframes.push({ t: round(t), x: round(fx.filter(p.x, t)), y: round(fy.filter(p.y, t)) });
  }

  const cursorPath: CursorPath = { origin: "auto", mode: params.mode, keyframes, clicks };

  if (params.mode !== "full") return { cursorPath };

  // "full" mode: re-run auto-zoom on the optimized track so the camera follows the clean path.
  const synth: CursorEvent[] = [
    ...keyframes.map((k) => ({ t: k.t, x: k.x, y: k.y, e: "move" as const })),
    ...clicks.map((c) => ({ t: c.t, x: c.x, y: c.y, e: "down" as const, b: c.button })),
  ].sort((a, b) => a.t - b.t);
  const retimedZooms = generateZooms(synth, meta);
  return { cursorPath, retimedZooms };
}

/** Convenience wrapper driven by the three sliders + mode toggle (Cursorcraft UI). */
export function optimizeCursorFromControls(
  cursor: CursorEvent[],
  meta: GenerateMeta,
  controls: CursorOptControls,
  beats?: BeatPlan,
): OptimizeResult {
  return optimizeCursor(cursor, meta, paramsFromControls(controls), beats);
}
