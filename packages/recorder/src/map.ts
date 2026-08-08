/**
 * Map a DOM event to a walkthrough Step (pure given the event + context). The heavy lifting —
 * generating self-healing locators — is delegated to @dolly/selector.
 */
import type { Rect2D, Step, StepAction } from "@dolly/schema";
import { describe, normRect } from "@dolly/selector";
import { isSensitive, maskValue } from "./mask.js";

/** Navigation keys we record for replay timing/behavior; character keys are not logged. */
const NAV_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Backspace",
  "Delete",
]);

export interface MapContext {
  /** seconds from recording start */
  t: number;
  /** current viewport size (for rect normalization) */
  viewport: { w: number; h: number };
  /** id to assign to this step */
  id: string;
}

function actionFor(event: Event): StepAction | null {
  switch (event.type) {
    case "click":
      return "click";
    case "dblclick":
      return "dblclick";
    case "input":
      return "input";
    case "change":
      return "change";
    case "submit":
      return "submit";
    case "scroll":
      return "scroll";
    case "keydown":
      return "keypress";
    default:
      return null;
  }
}

function fieldValue(el: Element): { value?: string; masked?: boolean } {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select") return {};
  const raw = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "";
  if (isSensitive(el)) return { value: maskValue(raw), masked: true };
  return { value: raw, masked: false };
}

/** Build a Step from a DOM event, or null if the event isn't worth recording. */
export function mapEventToStep(event: Event, ctx: MapContext): Step | null {
  const action = actionFor(event);
  if (!action) return null;

  // keypress: only record navigation keys (typing is captured by the resulting input event)
  if (action === "keypress") {
    const ke = event as KeyboardEvent;
    if (!NAV_KEYS.has(ke.key)) return null;
    const target = event.target as Element | null;
    const step: Step = { id: ctx.id, t: ctx.t, action, key: ke.key };
    if (target && target.nodeType === 1 && target !== event.currentTarget) {
      step.target = describe(target, target.ownerDocument);
      step.rect = safeRect(target, ctx.viewport);
    }
    return step;
  }

  const target = event.target as Element | null;

  // scroll: record the scroll position; a document/window scroll has no meaningful target
  if (action === "scroll") {
    const el = target && target.nodeType === 1 ? (target as Element) : null;
    const doc = el?.ownerDocument ?? (target as Document | null) ?? null;
    const scroll = el
      ? { x: (el as HTMLElement).scrollLeft, y: (el as HTMLElement).scrollTop }
      : {
          x: doc?.documentElement?.scrollLeft ?? 0,
          y: doc?.documentElement?.scrollTop ?? 0,
        };
    const step: Step = { id: ctx.id, t: ctx.t, action, scroll };
    if (el && el !== doc?.documentElement && el !== doc?.body) {
      step.target = describe(el, el.ownerDocument);
      step.rect = safeRect(el, ctx.viewport);
    }
    return step;
  }

  if (!target || target.nodeType !== 1) return null;
  const doc = target.ownerDocument;
  const step: Step = {
    id: ctx.id,
    t: ctx.t,
    action,
    target: describe(target, doc),
    rect: safeRect(target, ctx.viewport),
  };
  const fv = fieldValue(target);
  if (fv.value !== undefined) {
    step.value = fv.value;
    step.masked = fv.masked;
  }
  return step;
}

/** A synthetic navigation step (recorded by the content script on URL change, not a DOM event). */
export function makeNavigateStep(url: string, t: number, id: string): Step {
  return { id, t, action: "navigate", url };
}

function safeRect(el: Element, viewport: { w: number; h: number }): Rect2D | undefined {
  try {
    return normRect(el, viewport);
  } catch {
    return undefined;
  }
}
