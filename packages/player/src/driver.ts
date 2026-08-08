/**
 * The live-driver primitives (pure/DOM-effectful, jsdom-testable): resolve a step's target
 * with self-healing, decide auto-run vs. coach, map an action to the event that completes it,
 * and dispatch an action into the page. The player loop (player.ts) composes these with the
 * cursor overlay and timing.
 */
import { resolve, type ResolveResult } from "@dolly/selector";
import type { Step } from "@dolly/schema";

export type ResolvedMode = "auto" | "coach";

/** Effective live mode for a step: destructive steps are coached; else the step's mode, else the default. */
export function effectiveMode(step: Step, liveDefault: ResolvedMode): ResolvedMode {
  if (step.destructive) return "coach";
  if (step.liveMode && step.liveMode !== "inherit") return step.liveMode;
  return liveDefault;
}

/** The DOM event whose occurrence means the user completed this step (coach mode), or null. */
export function expectedEventType(action: Step["action"]): string | null {
  switch (action) {
    case "click":
    case "dblclick":
    case "input":
    case "change":
    case "submit":
      return action;
    case "keypress":
      return "keydown";
    case "hover":
      return "mouseover";
    default:
      return null;
  }
}

export interface ResolveStepOptions {
  viewport?: { w: number; h: number };
  threshold?: number;
}

export interface StepResolution {
  status: "ready" | "notarget" | "notfound";
  result?: ResolveResult;
  el?: Element | null;
}

/** Resolve a step's target element (self-healing). Steps without a target report "notarget". */
export function resolveStep(step: Step, doc: Document, opts: ResolveStepOptions = {}): StepResolution {
  if (!step.target) return { status: "notarget", el: null };
  const r = resolve(step.target, doc, { rect: step.rect, viewport: opts.viewport, threshold: opts.threshold });
  if (!r) return { status: "notfound" };
  return { status: "ready", result: r, el: r.el };
}

export type DispatchOutcome =
  | { kind: "done" }
  | { kind: "needsInput" }
  | { kind: "navigate"; url: string }
  | { kind: "unsupported" };

/** Perform a step's action in the page (auto-run). Masked inputs pause for real user entry. */
export function dispatchAction(step: Step, el: Element | null): DispatchOutcome {
  switch (step.action) {
    case "click":
      (el as HTMLElement | null)?.click();
      return { kind: "done" };
    case "dblclick":
      el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      (el as HTMLElement | null)?.click();
      return { kind: "done" };
    case "input":
    case "change": {
      if (step.masked) return { kind: "needsInput" }; // never synthesize a secret we don't hold
      const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (!field) return { kind: "unsupported" };
      if (step.value !== undefined) field.value = step.value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return { kind: "done" };
    }
    case "submit": {
      const form = (el?.closest?.("form") ?? null) as HTMLFormElement | null;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { kind: "done" };
      }
      (el as HTMLElement | null)?.click();
      return { kind: "done" };
    }
    case "scroll":
      if (step.scroll && typeof window !== "undefined") window.scrollTo(step.scroll.x, step.scroll.y);
      return { kind: "done" };
    case "keypress":
      el?.dispatchEvent(new KeyboardEvent("keydown", { key: step.key ?? "Enter", bubbles: true }));
      return { kind: "done" };
    case "hover":
      el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return { kind: "done" };
    case "navigate":
      return { kind: "navigate", url: step.url ?? "" };
    default:
      return { kind: "unsupported" };
  }
}
