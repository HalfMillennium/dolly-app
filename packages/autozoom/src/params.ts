/**
 * Auto-zoom parameters and their defaults (BUILD_PLAN §6.4).
 *
 * These defaults are the contract — do NOT invent your own. Changing any value must be
 * justified against the six-fixture regression suite (test/generate.test.ts).
 */
export interface AutoZoomParams {
  /** grid the cursor is resampled to (Hz) */
  resampleHz: number;
  /** One Euro filter constants for jitter removal */
  minCutoff: number;
  beta: number;
  /** events closer than this in time may join a cluster (seconds) */
  mergeGap: number;
  /** normalized diagonal distance for the same cluster */
  mergeRadius: number;
  /** clusters shorter than this are dropped unless they contain a click (seconds) */
  minDwell: number;
  /** segment starts this far before the first event (seconds) */
  leadIn: number;
  /** segment ends this far after the last event (seconds) */
  tail: number;
  /** ease durations (seconds); out is longer, it reads better */
  rampIn: number;
  rampOut: number;
  /** minimum quiet time between consecutive segments, ramps included (seconds) */
  minGap: number;
  /** mapped from cluster spatial spread, tight -> high */
  scaleRange: [number, number];
  /** fraction of the trimmed duration that may be zoomed */
  maxCoverage: number;
  /** density ceiling: at most one segment per this many seconds */
  maxRatePerSeconds: number;
  /** cluster spread above which focal mode becomes "follow" */
  followThreshold: number;
  /**
   * Damping for a "follow" focal spring. Not in the §6.4 table but structurally required by
   * the follow focal (§3.3 uses 0.12); the smoothness control scales it alongside the ramps.
   */
  followDamping: number;
}

export const DEFAULT_PARAMS: AutoZoomParams = {
  resampleHz: 30,
  minCutoff: 1.0,
  beta: 0.02,
  mergeGap: 1.2,
  mergeRadius: 0.18,
  minDwell: 0.6,
  leadIn: 0.35,
  tail: 0.6,
  rampIn: 0.45,
  rampOut: 0.6,
  minGap: 1.5,
  scaleRange: [1.4, 2.4],
  maxCoverage: 0.55,
  maxRatePerSeconds: 4,
  followThreshold: 0.25,
  followDamping: 0.12,
};

/**
 * The three user-facing controls (BUILD_PLAN §6.4 "UI affordance"). These map the friendly
 * sliders/toggle onto the full parameter set so the debug panel and the simple panel share
 * one code path.
 */
export interface AutoZoomControls {
  /** 0..1, scales maxCoverage and scaleRange together (default 0.5 == defaults) */
  intensity: number;
  /** 0..1, scales ramps and follow damping (default 0.5 == defaults) */
  smoothness: number;
  /** drops scroll/key/dwell scoring, zooming on clicks only */
  clicksOnly: boolean;
}

export const DEFAULT_CONTROLS: AutoZoomControls = {
  intensity: 0.5,
  smoothness: 0.5,
  clicksOnly: false,
};

/**
 * Resolve the three simple controls into a full AutoZoomParams, starting from `base`
 * (defaults unless overridden). intensity/smoothness are centered at 0.5 == no change, so
 * the "middle" of each slider reproduces the BUILD_PLAN defaults exactly.
 */
export function paramsFromControls(
  controls: AutoZoomControls,
  base: AutoZoomParams = DEFAULT_PARAMS,
): AutoZoomParams {
  // intensity: 0.5 -> 1.0x; 0 -> 0.6x; 1 -> 1.4x
  const iMul = 0.6 + 0.8 * controls.intensity;
  // smoothness: 0.5 -> 1.0x; 0 -> 0.6x; 1 -> 1.6x
  const sMul = 0.6 + 0.8 * controls.smoothness + (controls.smoothness > 0.5 ? (controls.smoothness - 0.5) * 0.4 : 0);
  const [lo, hi] = base.scaleRange;
  const scaledHi = 1 + (hi - 1) * iMul;
  const scaledLo = 1 + (lo - 1) * iMul;
  return {
    ...base,
    maxCoverage: Math.min(0.9, base.maxCoverage * iMul),
    scaleRange: [Math.max(1, scaledLo), Math.max(1.01, scaledHi)],
    rampIn: base.rampIn * sMul,
    rampOut: base.rampOut * sMul,
    followDamping: base.followDamping * sMul,
  };
}
