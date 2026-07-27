/**
 * The "beat plan" — an ordered sequence of waypoints the optimized cursor should hit. This is
 * the seam between the pure optimizer and the optional AI director (BUILD_PLAN Cursorcraft §4).
 *
 * `optimizeCursor` accepts an optional BeatPlan. When absent, it derives beats locally from the
 * recorded track (the offline, deterministic default). When present — produced by the app-layer
 * LLM director — the optimizer follows the planned order/emphasis instead. Either way the
 * optimizer stays pure: the LLM never runs here, it only supplies this data structure.
 */

export interface Beat {
  /** target location, normalized [0,1] top-left */
  x: number;
  y: number;
  /** seconds to hold on this beat (a deliberate pause). Omitted -> params.dwell */
  dwell?: number;
  /** true if this beat corresponds to a click (drives a ripple) */
  click?: boolean;
  /** optional arrival time (seconds). Omitted -> distributed across the timeline */
  t?: number;
  /** optional short ad-copy / voiceover line the director suggests for this beat (UI only) */
  adCopy?: string;
}

export interface BeatPlan {
  beats: Beat[];
  /** whether these beats came from the local heuristic or the LLM director */
  source: "local" | "llm";
}

export interface BeatProviderInput {
  /** ordered targets discovered from the recorded track */
  targets: Array<{ t: number; x: number; y: number; click: boolean; score: number }>;
  duration: number;
}

/** A source of beats. The pure local provider is the default; the LLM provider is app-layer. */
export type BeatProvider = (input: BeatProviderInput) => BeatPlan;

/**
 * The default, offline beat provider: keep the observed targets in time order, one beat each.
 * This is what makes the feature work with zero network and zero configuration.
 */
export const localBeatProvider: BeatProvider = ({ targets }) => ({
  source: "local",
  beats: targets.map((t) => ({ x: t.x, y: t.y, click: t.click, t: t.t })),
});
