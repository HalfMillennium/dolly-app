/**
 * DollyPlayer — the embeddable walkthrough player.
 *
 * WATCH: play the recorded video with the synthetic cursor overlay following the recording's
 *        cursor path.
 * LIVE:  drive the walkthrough in the viewer's own page — resolve each step's target
 *        (self-healing), move the cursor to it, spotlight it, then auto-run the action or coach
 *        the user to do it. Destructive/masked steps pause for the user.
 *
 * Browser runtime; the pure decision core (resolve/mode/dispatch) lives in driver.ts and is
 * unit-tested there.
 */
import { catmullRomAt, type Recording, type Step } from "@dolly/schema";
import { CursorOverlay } from "@dolly/cursor";
import {
  dispatchAction,
  effectiveMode,
  expectedEventType,
  resolveStep,
  type ResolvedMode,
} from "./driver.js";

export type StepStatus = "start" | "done" | "notfound" | "needsInput" | "skipped";

export interface StepEvent {
  index: number;
  step: Step;
  status: StepStatus;
}

export interface DollyPlayerConfig {
  recording: Recording;
  /** default is "watch" when the recording has a video, else "live" */
  mode?: "watch" | "live";
  /** default live behavior when a step does not specify one */
  liveDefault?: ResolvedMode;
  /** where to mount the overlay/video (defaults to document.body) */
  container?: HTMLElement;
  /** a resolved video URL for watch mode (e.g. an object URL for the recorded blob) */
  videoUrl?: string;
  /** self-heal confidence threshold */
  threshold?: number;
  onStep?: (e: StepEvent) => void;
  onComplete?: () => void;
}

interface Point {
  x: number;
  y: number;
}

export class DollyPlayer {
  private overlay: CursorOverlay | null = null;
  private aborted = false;
  private cursor: Point = { x: 0, y: 0 };

  constructor(private config: DollyPlayerConfig) {}

  async start(): Promise<void> {
    this.aborted = false;
    const mode = this.config.mode ?? (this.config.recording.video ? "watch" : "live");
    return mode === "watch" ? this.watch() : this.live();
  }

  stop(): void {
    this.aborted = true;
    this.overlay?.destroy();
    this.overlay = null;
  }

  private viewport(): { w: number; h: number } {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private ensureOverlay(): CursorOverlay {
    if (!this.overlay) {
      this.overlay = new CursorOverlay({ container: this.config.container });
      this.overlay.mount();
    }
    return this.overlay;
  }

  // ---------------------------------------------------------------- live driver
  private async live(): Promise<void> {
    const rec = this.config.recording;
    const overlay = this.ensureOverlay();
    const liveDefault = this.config.liveDefault ?? "auto";

    for (let i = 0; i < rec.steps.length && !this.aborted; i++) {
      const step = rec.steps[i]!;
      this.config.onStep?.({ index: i, step, status: "start" });
      await this.awaitWaitFor(step);

      const res = resolveStep(step, document, { viewport: this.viewport(), threshold: this.config.threshold });
      if (res.status === "notfound") {
        this.config.onStep?.({ index: i, step, status: "notfound" });
        continue;
      }
      const el = res.el ?? null;
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center" });
        await this.moveTo(centerOf(el));
        overlay.render({ cursor: this.cursor, spotlight: rectOf(el) });
      }

      const mode = effectiveMode(step, liveDefault);
      if (mode === "auto") {
        const out = dispatchAction(step, el);
        this.ripple(this.cursor);
        if (out.kind === "needsInput") {
          this.config.onStep?.({ index: i, step, status: "needsInput" });
          await this.awaitUser(step, el);
        }
        // navigate in an embedded context is left to the host app (onStep can react)
      } else {
        await this.awaitUser(step, el);
      }
      this.config.onStep?.({ index: i, step, status: "done" });
    }

    overlay.render({ spotlight: null });
    if (!this.aborted) this.config.onComplete?.();
  }

  private awaitWaitFor(step: Step): Promise<void> {
    const w = step.waitFor;
    if (!w) return Promise.resolve();
    if (w.type === "delay") return this.delay(w.ms ?? 0);
    return this.pollFor(() => {
      if (w.type === "url") return location.href.includes(w.value ?? "");
      if (w.type === "element" && w.value) {
        try {
          return !!document.querySelector(w.value);
        } catch {
          return false;
        }
      }
      return true;
    });
  }

  private awaitUser(step: Step, el: Element | null): Promise<void> {
    const type = expectedEventType(step.action);
    if (!type || !el) return this.delay(400);
    return new Promise<void>((resolvePromise) => {
      const handler = (): void => {
        el.removeEventListener(type, handler, true);
        resolvePromise();
      };
      el.addEventListener(type, handler, true);
    });
  }

  private async moveTo(target: Point): Promise<void> {
    const overlay = this.ensureOverlay();
    const from = { ...this.cursor };
    if (from.x === 0 && from.y === 0) {
      this.cursor = { ...target };
      overlay.render({ cursor: this.cursor });
      return;
    }
    const dur = 500;
    const start = performance.now();
    await new Promise<void>((done) => {
      const frame = (now: number): void => {
        const p = Math.min(1, (now - start) / dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // cubicInOut
        this.cursor = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
        overlay.render({ cursor: this.cursor });
        if (p < 1 && !this.aborted) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
  }

  private ripple(pt: Point): void {
    const overlay = this.ensureOverlay();
    const start = performance.now();
    const frame = (now: number): void => {
      const p = Math.min(1, (now - start) / 350);
      overlay.render({ cursor: this.cursor, ripples: [{ x: pt.x, y: pt.y, p }] });
      if (p < 1 && !this.aborted) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private pollFor(cond: () => boolean, timeout = 5000): Promise<void> {
    return new Promise<void>((done) => {
      const start = performance.now();
      const tick = (): void => {
        if (cond() || performance.now() - start > timeout || this.aborted) return done();
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  // ---------------------------------------------------------------- watch
  private async watch(): Promise<void> {
    const rec = this.config.recording;
    const container = this.config.container ?? document.body;
    const overlay = this.ensureOverlay();

    const video = document.createElement("video");
    video.controls = true;
    video.style.maxWidth = "100%";
    if (this.config.videoUrl) video.src = this.config.videoUrl;
    container.appendChild(video);

    const path = rec.cursorPath;
    const follow = (): void => {
      if (this.aborted) return;
      const t = video.currentTime;
      if (path && path.keyframes.length) {
        const n = catmullRomAt(path.keyframes, t);
        this.cursor = { x: n.x * window.innerWidth, y: n.y * window.innerHeight };
        overlay.render({ cursor: this.cursor });
      }
      const rvfc = (video as unknown as {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(video, () => follow());
      else requestAnimationFrame(follow);
    };
    follow();
  }
}

function centerOf(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
