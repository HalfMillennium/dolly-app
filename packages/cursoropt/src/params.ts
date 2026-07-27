/**
 * Parameters and user-facing controls for the AI-optimized cursor ("Cursorcraft").
 *
 * Mirrors the shape of @dolly/autozoom's params/controls so the two features feel consistent.
 */
import type { CursorPathMode } from "@dolly/schema";

export interface CursorOptParams {
  /** grid the raw cursor is resampled to for target extraction (Hz) — matches auto-zoom */
  resampleHz: number;
  /** One Euro filter constants used during target extraction */
  minCutoff: number;
  beta: number;
  /** output keyframe sampling rate (Hz) */
  sampleHz: number;
  /** seconds the cursor holds still on each target (a natural "landed" pause) */
  dwell: number;
  /** minimum move duration between two targets (seconds); guards against teleporting */
  minMove: number;
  /** 0..1 — output smoothing (One Euro cutoff on the emitted keyframes); higher = smoother */
  smoothness: number;
  /** 1 = straight moves; <1 bows the move path outward for a softer, hand-like arc */
  straightness: number;
  /** scales move/dwell timing; >1 slower & more deliberate, <1 snappier */
  speed: number;
  /** which artifacts to produce */
  mode: CursorPathMode;
}

export const DEFAULT_PARAMS: CursorOptParams = {
  resampleHz: 30,
  minCutoff: 1.0,
  beta: 0.02,
  sampleHz: 30,
  dwell: 0.5,
  minMove: 0.3,
  smoothness: 0.5,
  straightness: 1.0,
  speed: 1.0,
  mode: "pathClicks",
};

/** The user-facing controls (three sliders + a mode toggle), mirroring the auto-zoom panel. */
export interface CursorOptControls {
  /** 0..1, centered at 0.5 == defaults */
  speed: number;
  smoothness: number;
  straightness: number;
  mode: CursorPathMode;
}

export const DEFAULT_CONTROLS: CursorOptControls = {
  speed: 0.5,
  smoothness: 0.5,
  straightness: 0.5,
  mode: "pathClicks",
};

/** Resolve the sliders (0..1, 0.5 == neutral) into a full CursorOptParams. */
export function paramsFromControls(
  controls: CursorOptControls,
  base: CursorOptParams = DEFAULT_PARAMS,
): CursorOptParams {
  return {
    ...base,
    // speed: 0.5 -> 1.0x; 0 -> 0.6x (snappier); 1 -> 1.6x (slower/deliberate)
    speed: 0.6 + controls.speed * (controls.speed > 0.5 ? 2.0 : 0.8),
    smoothness: controls.smoothness,
    // straightness slider 0..1 maps to path straightness 0.7..1.0 (never wildly bowed)
    straightness: 0.7 + controls.straightness * 0.3,
    mode: controls.mode,
  };
}
