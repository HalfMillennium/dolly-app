/**
 * @dolly/player — the embeddable walkthrough SDK.
 *
 * - `<dolly-walkthrough>` custom element (call `registerWalkthroughElement()` once) for drop-in
 *   embeds, or the `DollyPlayer` class for programmatic control.
 * - The pure/DOM driver primitives (self-healing resolution, mode selection, action dispatch) are
 *   re-exported for hosts that want to build their own runtime.
 */
export { DollyPlayer } from "./player.js";
export type { DollyPlayerConfig, StepEvent, StepStatus } from "./player.js";
export { DollyWalkthroughElement, registerWalkthroughElement } from "./component.js";
export {
  effectiveMode,
  expectedEventType,
  resolveStep,
  dispatchAction,
} from "./driver.js";
export type {
  ResolvedMode,
  ResolveStepOptions,
  StepResolution,
  DispatchOutcome,
} from "./driver.js";
