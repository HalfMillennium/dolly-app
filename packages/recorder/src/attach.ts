/**
 * Attach capture-phase DOM listeners that stream walkthrough Steps to a sink. Thin wrapper over
 * `mapEventToStep`; the extension content script calls this on "start recording".
 */
import type { Step } from "@dolly/schema";
import { mapEventToStep } from "./map.js";

export interface AttachOptions {
  /** monotonic clock in ms (defaults to performance.now / Date.now) */
  now?: () => number;
  /** current viewport size (defaults to the document's window) */
  viewport?: () => { w: number; h: number };
  /** minimum ms between recorded scroll steps */
  scrollThrottleMs?: number;
}

/** Install listeners; returns a detach function. */
export function attach(root: Document, sink: (step: Step) => void, opts: AttachOptions = {}): () => void {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const start = now();
  const viewport =
    opts.viewport ??
    (() => ({ w: root.defaultView?.innerWidth ?? 0, h: root.defaultView?.innerHeight ?? 0 }));
  let counter = 0;
  const seconds = (): number => (now() - start) / 1000;

  const emit = (event: Event): void => {
    const step = mapEventToStep(event, { t: seconds(), viewport: viewport(), id: `s${counter + 1}` });
    if (step) {
      counter += 1;
      sink(step);
    }
  };

  let lastScroll = -Infinity;
  const scrollThrottle = opts.scrollThrottleMs ?? 200;
  const onScroll = (event: Event): void => {
    const nowMs = now();
    if (nowMs - lastScroll < scrollThrottle) return;
    lastScroll = nowMs;
    emit(event);
  };

  const listeners: Array<[string, EventListener]> = [
    ["click", emit],
    ["dblclick", emit],
    ["input", emit],
    ["change", emit],
    ["submit", emit],
    ["keydown", emit],
    ["scroll", onScroll],
  ];
  for (const [type, fn] of listeners) root.addEventListener(type, fn, true);
  return () => {
    for (const [type, fn] of listeners) root.removeEventListener(type, fn, true);
  };
}
