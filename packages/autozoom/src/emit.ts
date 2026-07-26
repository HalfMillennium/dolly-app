/**
 * Steps 5-8 of the auto-zoom pipeline (BUILD_PLAN §6.4): emit a segment per cluster (spatial
 * median focal, MAD spread, reversed scale map), resolve overlaps, enforce the coverage/rate
 * budget, and produce `origin:"auto"` Zoom objects.
 */
import { clamp, normDistance } from "@dolly/schema";
import type { Zoom } from "@dolly/schema";
import type { Cluster } from "./cluster.js";
import type { AutoZoomParams } from "./params.js";

interface Pt {
  x: number;
  y: number;
}

export interface Segment {
  start: number;
  end: number;
  focalX: number;
  focalY: number;
  spread: number;
  scale: number;
  mode: "fixed" | "follow";
  score: number;
  points: Pt[];
  hasClick: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Spatial spread: median absolute deviation of member points from the median focal. */
function madSpread(points: Pt[], fx: number, fy: number): number {
  const dists = points.map((p) => Math.hypot(p.x - fx, p.y - fy));
  return median(dists);
}

/** Reversed scale map (§6.4 step 5): tight spread -> high scale. */
function scaleFromSpread(spread: number, range: [number, number]): number {
  const [lo, hi] = range;
  const f = clamp((spread - 0.02) / (0.3 - 0.02), 0, 1);
  return clamp(hi + f * (lo - hi), Math.min(lo, hi), Math.max(lo, hi));
}

function buildSegment(
  points: Pt[],
  start: number,
  end: number,
  score: number,
  hasClick: boolean,
  p: AutoZoomParams,
): Segment {
  const fx = median(points.map((q) => q.x));
  const fy = median(points.map((q) => q.y));
  const spread = madSpread(points, fx, fy);
  return {
    start,
    end,
    focalX: fx,
    focalY: fy,
    spread,
    scale: scaleFromSpread(spread, p.scaleRange),
    mode: spread > p.followThreshold ? "follow" : "fixed",
    score,
    points,
    hasClick,
  };
}

/** §6.4 step 5: emit one segment per surviving cluster. */
export function emitSegments(clusters: Cluster[], duration: number, p: AutoZoomParams): Segment[] {
  return clusters.map((c) => {
    const start = clamp(c.firstT - p.leadIn, 0, duration);
    const end = clamp(c.lastT + p.tail, 0, duration);
    const points = c.events.map((e) => ({ x: e.x, y: e.y }));
    return buildSegment(points, start, end, c.totalScore, c.hasClick, p);
  });
}

/**
 * §6.4 step 6: resolve conflicts left-to-right. When the earlier segment's tail sits within
 * `minGap` of the next segment's start, merge if the focals are close, otherwise truncate the
 * earlier tail; if truncation would shorten it below `minDwell`, drop the lower-scoring one.
 */
export function resolveConflicts(segments: Segment[], p: AutoZoomParams): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const stack: Segment[] = [];
  for (const seg of sorted) {
    let cur = seg;
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const gap = cur.start - top.end;
      if (gap >= p.minGap) break;
      const focalDist = normDistance(top.focalX, top.focalY, cur.focalX, cur.focalY);
      if (focalDist < p.mergeRadius) {
        // merge top + cur into one segment
        stack.pop();
        cur = buildSegment(
          [...top.points, ...cur.points],
          Math.min(top.start, cur.start),
          Math.max(top.end, cur.end),
          top.score + cur.score,
          top.hasClick || cur.hasClick,
          p,
        );
        continue;
      }
      // truncate the earlier tail to satisfy minGap
      const truncatedEnd = cur.start - p.minGap;
      if (truncatedEnd - top.start >= p.minDwell) {
        top.end = truncatedEnd;
        break;
      }
      // truncation too aggressive: drop the lower-scoring segment
      if (top.score >= cur.score) {
        // keep top, drop cur
        cur = top;
        stack.pop();
        // re-evaluate cur (== old top) against the new stack top
        continue;
      } else {
        // drop top, keep cur
        stack.pop();
        continue;
      }
    }
    if (stack.length === 0 || stack[stack.length - 1] !== cur) stack.push(cur);
  }
  return stack;
}

function coverage(segments: Segment[], duration: number): number {
  if (duration <= 0) return 0;
  return segments.reduce((s, seg) => s + (seg.end - seg.start), 0) / duration;
}

/** True if any two consecutive segment starts are closer than the density ceiling. */
function rateViolation(segments: Segment[], maxRatePerSeconds: number): boolean {
  const starts = segments.map((s) => s.start).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! - starts[i - 1]! < maxRatePerSeconds) return true;
  }
  return false;
}

/**
 * §6.4 step 7: while coverage exceeds `maxCoverage` or the density exceeds `maxRate`, drop
 * the lowest-scoring segment. This is the step that keeps busy recordings from becoming
 * nauseating — do not skip it.
 */
export function applyBudget(segments: Segment[], duration: number, p: AutoZoomParams): Segment[] {
  let segs = [...segments];
  while (
    segs.length > 0 &&
    (coverage(segs, duration) > p.maxCoverage || rateViolation(segs, p.maxRatePerSeconds))
  ) {
    // find and drop the lowest-scoring segment
    let worst = 0;
    for (let i = 1; i < segs.length; i++) {
      if (segs[i]!.score < segs[worst]!.score) worst = i;
    }
    segs.splice(worst, 1);
  }
  return segs;
}

/** §6.4 step 8: materialize segments as `origin:"auto"` Zoom objects. */
export function toZooms(segments: Segment[], p: AutoZoomParams): Zoom[] {
  return segments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((seg, i) => {
      const focal =
        seg.mode === "follow"
          ? ({ mode: "follow", damping: p.followDamping, track: "cursor" } as const)
          : ({ mode: "fixed", x: round(seg.focalX), y: round(seg.focalY) } as const);
      return {
        id: `z${i + 1}`,
        start: round(seg.start),
        end: round(seg.end),
        scale: round(seg.scale),
        focal,
        rampIn: round(p.rampIn),
        rampOut: round(p.rampOut),
        easing: "cubicInOut",
        origin: "auto",
      } satisfies Zoom;
    });
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
