/**
 * Shared render math for DOLLY.
 *
 * These functions are the single source of truth for geometry and easing that must be
 * IDENTICAL in the TypeScript preview renderer (`apps/desktop/src/preview`) and the Swift
 * export renderer (`native/dollyd/Export`). Preview/export divergence (BUILD_PLAN §2.3,
 * §6.6) is the largest correctness risk in the product; the parity test exists to catch
 * drift, and these functions exist to prevent it.
 *
 * When you change anything here, mirror it in the Swift port and keep the parity test green.
 * The Swift mirror lives at native/dollyd/Sources/dollyd/Model/RenderMath.swift.
 */

/** A 2D affine transform in the same (a,b,c,d,e,f) convention as CanvasRenderingContext2D:
 *  x' = a*x + c*y + e ;  y' = b*x + d*y + f  */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** An axis-aligned rectangle (the aspect-fit "content rect" the source video is drawn into). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A focal point in source-normalized [0,1] coordinates, origin top-left. */
export interface Focal {
  x: number;
  y: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Clamp a zoom focal point so that a scale-`s` zoom never lets the backdrop bleed through
 * at the edges of the content rect (BUILD_PLAN §6.3). At scale `s`, the visible normalized
 * half-window is 1/(2s); the focal must stay at least that far from each edge.
 *
 * `s` is expected to be >= 1. For s <= 1 the window covers the whole frame, so the focal
 * collapses to the center (0.5, 0.5).
 */
export function focalClamp(focal: Focal, s: number): Focal {
  if (s <= 1) return { x: 0.5, y: 0.5 };
  const m = 1 / (2 * s);
  return {
    x: clamp(focal.x, m, 1 - m),
    y: clamp(focal.y, m, 1 - m),
  };
}

/**
 * Compose the zoom transform about a focal point (BUILD_PLAN §6.3). Given the aspect-fit
 * content rect the source is drawn into, a scale `s`, and an ALREADY-CLAMPED focal in
 * source-normalized coordinates, returns the affine matrix equivalent to the canvas ops:
 *
 *   translate(cx, cy); scale(s, s); translate(-px, -py)
 *
 * Callers that hold a raw (possibly unclamped) focal should run it through `focalClamp`
 * first; `zoomMatrix` does not clamp so the geometry stays a pure function of its inputs.
 */
export function zoomMatrix(content: Rect, s: number, focal: Focal): Mat2D {
  const px = content.x + focal.x * content.w;
  const py = content.y + focal.y * content.h;
  const cx = content.x + content.w / 2;
  const cy = content.y + content.h / 2;
  return {
    a: s,
    b: 0,
    c: 0,
    d: s,
    e: cx - s * px,
    f: cy - s * py,
  };
}

/** Convenience: clamp the focal for scale `s`, then compose the transform. */
export function zoomTransform(content: Rect, s: number, focal: Focal): Mat2D {
  return zoomMatrix(content, s, focalClamp(focal, s));
}

/** Apply a Mat2D to a point. */
export function applyMat(m: Mat2D, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// ---------------------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------------------

/** cubicInOut easing on [0,1]. */
export function cubicInOut(t: number): number {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** cubicOut easing on [0,1] (used for the click ripple, BUILD_PLAN §6.5). */
export function cubicOut(t: number): number {
  const u = clamp(t, 0, 1);
  return 1 - Math.pow(1 - u, 3);
}

export type Easing = "cubicInOut" | "cubicOut" | "linear";

export function ease(kind: Easing, t: number): number {
  switch (kind) {
    case "cubicInOut":
      return cubicInOut(t);
    case "cubicOut":
      return cubicOut(t);
    case "linear":
      return clamp(t, 0, 1);
  }
}

// ---------------------------------------------------------------------------------------
// Zoom scale over time (ramps)
// ---------------------------------------------------------------------------------------

export interface ZoomRamp {
  start: number;
  end: number;
  scale: number;
  rampIn: number;
  rampOut: number;
  easing: Easing;
}

/**
 * The effective zoom scale at time `t` for a single zoom segment, interpolating from 1.0
 * up to `scale` across `rampIn`, holding, then back to 1.0 across `rampOut` (BUILD_PLAN
 * §6.3). Outside the segment the scale is 1.0. Ramps are clamped so they never overlap
 * past the segment midpoint.
 */
export function zoomScaleAt(z: ZoomRamp, t: number): number {
  if (t <= z.start || t >= z.end) return 1;
  const dur = z.end - z.start;
  const rampIn = Math.min(z.rampIn, dur / 2);
  const rampOut = Math.min(z.rampOut, dur / 2);
  const local = t - z.start;
  if (local < rampIn) {
    return 1 + (z.scale - 1) * ease(z.easing, local / rampIn);
  }
  const fromEnd = z.end - t;
  if (fromEnd < rampOut) {
    return 1 + (z.scale - 1) * ease(z.easing, fromEnd / rampOut);
  }
  return z.scale;
}

// ---------------------------------------------------------------------------------------
// Critically damped spring (BUILD_PLAN §6.3, §6.5)
// ---------------------------------------------------------------------------------------

export interface SpringState {
  pos: number;
  vel: number;
}

/**
 * One integration step of the critically damped spring used to drive a "follow" focal
 * point toward a moving target, and to smooth the synthetic cursor. Matches BUILD_PLAN §6.3
 * exactly:
 *
 *   omega = 2*pi / damping
 *   k     = 1 - exp(-omega*dt)
 *   vel  += (target - pos) * k
 *   pos  += vel * dt
 *   vel  *= exp(-omega*dt)
 *
 * `damping` ~0.12 -> stiff, ~0.4 -> loose. `dt` is seconds. Returns the new state; the
 * input state is not mutated so callers can keep the function pure.
 */
export function springStep(
  state: SpringState,
  target: number,
  damping: number,
  dt: number,
): SpringState {
  const omega = (2 * Math.PI) / damping;
  const decay = Math.exp(-omega * dt);
  const k = 1 - decay;
  let vel = state.vel + (target - state.pos) * k;
  const pos = state.pos + vel * dt;
  vel *= decay;
  return { pos, vel };
}

/** Convenience: step a 2D spring (independent per axis). */
export interface Spring2D {
  x: SpringState;
  y: SpringState;
}

export function spring2DStep(
  s: Spring2D,
  target: { x: number; y: number },
  damping: number,
  dt: number,
): Spring2D {
  return {
    x: springStep(s.x, target.x, damping, dt),
    y: springStep(s.y, target.y, damping, dt),
  };
}

// ---------------------------------------------------------------------------------------
// One Euro filter (BUILD_PLAN §6.4 step 1, §6.5)
// ---------------------------------------------------------------------------------------

/**
 * The 1€ (One Euro) low-pass filter (Casiez, Roussel, Vogel 2012). Used to remove cursor
 * jitter before clustering (auto-zoom) and before rendering the synthetic cursor.
 *
 * `minCutoff` and `beta` default to the BUILD_PLAN §6.4 constants (1.0 / 0.02). The filter
 * is stateful and expects strictly increasing timestamps (seconds).
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Filter a sample taken at time `t` (seconds). First sample passes through unchanged. */
  filter(x: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dt = t - this.tPrev;
    if (dt <= 0) return this.xPrev; // ignore non-monotonic samples
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = OneEuroFilter.alpha(cutoff, dt);
    const xHat = aX * x + (1 - aX) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

// ---------------------------------------------------------------------------------------
// Geometry helpers shared by auto-zoom and rendering
// ---------------------------------------------------------------------------------------

/**
 * Compute the aspect-fit content rect: the canvas inset by `padding * min(W,H)`, then the
 * source aspect fit inside that inset box (BUILD_PLAN §6.3 step 2).
 */
export function contentRect(
  canvasW: number,
  canvasH: number,
  srcAspect: number,
  padding: number,
): Rect {
  const inset = padding * Math.min(canvasW, canvasH);
  const boxW = canvasW - 2 * inset;
  const boxH = canvasH - 2 * inset;
  const boxAspect = boxW / boxH;
  let w: number;
  let h: number;
  if (srcAspect > boxAspect) {
    w = boxW;
    h = boxW / srcAspect;
  } else {
    h = boxH;
    w = boxH * srcAspect;
  }
  return { x: inset + (boxW - w) / 2, y: inset + (boxH - h) / 2, w, h };
}

/** Euclidean distance between two normalized points, scaled to the [0,1]-square diagonal. */
export function normDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
}

// ---------------------------------------------------------------------------------------
// Catmull-Rom spline (AI-optimized cursor path, "Cursorcraft" feature)
// ---------------------------------------------------------------------------------------

/** A timestamped point on a cursor path, x/y normalized [0,1] top-left. */
export interface PathKey {
  t: number;
  x: number;
  y: number;
}

/**
 * Uniform Catmull-Rom interpolation (tension 0.5) of one scalar component across the four
 * control values p0..p3, at local parameter `u` in [0,1] (the segment is p1 -> p2).
 *
 * This is the position source for the optimized synthetic cursor and MUST be evaluated
 * identically in the TS preview renderer and the Swift export renderer (see math.ts header;
 * mirror is RenderMath.swift, guarded by the §6.6 parity test).
 */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

/**
 * Evaluate a Catmull-Rom cursor path (a time-sorted list of keyframes) at time `t`. Positions
 * before the first / after the last key are clamped to the endpoints. The segment containing
 * `t` is found by binary search; the local parameter is the time fraction within that segment,
 * and the two outer control points are the neighbours (clamped at the ends). Returns the
 * center (0.5, 0.5) for an empty path.
 */
export function catmullRomAt(keys: PathKey[], t: number): { x: number; y: number } {
  const n = keys.length;
  if (n === 0) return { x: 0.5, y: 0.5 };
  if (n === 1) return { x: keys[0]!.x, y: keys[0]!.y };
  if (t <= keys[0]!.t) return { x: keys[0]!.x, y: keys[0]!.y };
  const last = keys[n - 1]!;
  if (t >= last.t) return { x: last.x, y: last.y };

  // binary search for segment [i, i+1] with keys[i].t <= t < keys[i+1].t
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const p1 = keys[lo]!;
  const p2 = keys[hi]!;
  const p0 = keys[lo - 1] ?? p1;
  const p3 = keys[hi + 1] ?? p2;
  const span = p2.t - p1.t || 1;
  const u = clamp((t - p1.t) / span, 0, 1);
  return {
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
    y: catmullRom(p0.y, p1.y, p2.y, p3.y, u),
  };
}
