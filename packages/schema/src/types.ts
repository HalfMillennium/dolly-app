/**
 * DOLLY data contracts — the browser walkthrough Recording format.
 *
 * The JSON Schemas in `schema/` are the source of truth; `scripts/gen-ts.ts` regenerates types
 * from them in CI, and `test/schema-valid.test.ts` validates example documents. Kept in sync by
 * hand here for ergonomic discriminated unions.
 */

// --- cursor telemetry (shared with @dolly/autozoom, @dolly/cursoropt, @dolly/cursor) ----

export type CursorEventKind = "move" | "down" | "up" | "drag" | "scroll" | "key";
export type MouseButton = "left" | "right" | "other";

export interface CursorEvent {
  /** seconds from recording start */
  t: number;
  /** normalized [0,1], origin top-left. Absent for `key`. */
  x?: number;
  y?: number;
  e: CursorEventKind;
  b?: MouseButton;
  dy?: number;
}

/** Styling for the synthetic cursor overlay (used by @dolly/cursor). */
export interface CursorStyle {
  visible: boolean;
  size: number;
  smoothing: number;
  clickRipple: boolean;
  hideWhenIdle: number;
}

// --- optimized cursor path (shared with @dolly/cursoropt, @dolly/cursor) ----------------

// PathKey ({t,x,y}) is owned by math.ts (the Catmull-Rom evaluator).
import type { PathKey } from "./math.js";

export type ZoomOrigin = "auto" | "manual";
export type ZoomEasing = "cubicInOut" | "cubicOut" | "linear";
export type FocalMode = "fixed" | "follow";

export interface FixedFocal {
  mode: "fixed";
  x: number;
  y: number;
}
export interface FollowFocal {
  mode: "follow";
  damping: number;
  track: "cursor";
}
export type ZoomFocal = FixedFocal | FollowFocal;

/** A zoom segment (auto-zoom / cursoropt "full" mode); optional "zoom-to-element" polish. */
export interface Zoom {
  id: string;
  start: number;
  end: number;
  scale: number;
  focal: ZoomFocal;
  rampIn: number;
  rampOut: number;
  easing: ZoomEasing;
  origin: ZoomOrigin;
}

/** A click re-timed onto the optimized path; drives the synthetic-cursor ripple. */
export interface ClickMark {
  t: number;
  x: number;
  y: number;
  button?: MouseButton;
}

export type CursorPathMode = "pathClicks" | "full";

/** A smooth cursor performance derived from click targets, evaluated with the shared spline. */
export interface CursorPath {
  origin: ZoomOrigin;
  mode: CursorPathMode;
  keyframes: PathKey[];
  clicks: ClickMark[];
}

// --- the walkthrough Recording -----------------------------------------------------------

/** How an element is located, one strategy. `weight` is a stability prior (higher = better). */
export type LocatorStrategy =
  | "id"
  | "testid"
  | "aria"
  | "attr"
  | "text"
  | "css"
  | "xpath"
  | "relative"
  | "geom";

export interface Locator {
  strategy: LocatorStrategy;
  /** strategy-specific value (a CSS selector, XPath, accessible name, tag for geom, …) */
  value: string;
  weight: number;
}

/** A ranked set of locators for one element: the best plus ordered fallbacks (self-healing). */
export interface LocatorSet {
  primary: Locator;
  fallbacks: Locator[];
}

export type StepAction =
  | "click"
  | "dblclick"
  | "input"
  | "change"
  | "submit"
  | "scroll"
  | "navigate"
  | "hover"
  | "keypress"
  | "wait";

/** Per-step behavior when the walkthrough is driven live in the viewer's browser. */
export type LiveMode = "auto" | "coach" | "inherit";

/** A viewport-normalized rectangle [0,1]; used for the overlay and geometric self-healing. */
export interface Rect2D {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A precondition to satisfy before a step runs live (robust replay across async UIs). */
export interface WaitCondition {
  type: "element" | "url" | "delay";
  /** a locator value (element), a URL substring (url) */
  value?: string;
  /** milliseconds (delay) */
  ms?: number;
}

export interface Step {
  id: string;
  /** seconds from recording start */
  t: number;
  action: StepAction;
  /** the acted-on element (absent for navigate / window scroll) */
  target?: LocatorSet;
  /** typed value for input/change; may be masked */
  value?: string;
  masked?: boolean;
  /** key for keypress (navigation rhythm; never secret content) */
  key?: string;
  /** destination for navigate */
  url?: string;
  /** iframe path (same-origin) if the target lives in a frame */
  frame?: string;
  /** scroll position for scroll steps */
  scroll?: { x: number; y: number };
  /** element bounding rect at record time (viewport-normalized) */
  rect?: Rect2D;
  /** live-replay default for this step; the viewer may override */
  liveMode?: LiveMode;
  /** author annotation shown as a caption / tooltip */
  caption?: string;
  /** condition to await before running this step live */
  waitFor?: WaitCondition;
  /** marks an irreversible/destructive action — coached (not auto-run) unless forced */
  destructive?: boolean;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface RecordingVideo {
  format: "webm";
  width: number;
  height: number;
  duration: number;
}

export interface Recording {
  version: 1;
  id: string;
  title: string;
  /** ISO-8601 */
  createdAt: string;
  startUrl: string;
  viewport: Viewport;
  steps: Step[];
  /** optional real tab capture for "watch" mode */
  video?: RecordingVideo;
  /** optional precomputed smooth cursor path for the watch overlay (from @dolly/cursoropt) */
  cursorPath?: CursorPath;
}
