/**
 * `<dolly-walkthrough>` — the framework-agnostic embed. Product teams drop this custom element
 * into their own page and hand it a Recording; end users need no extension.
 *
 * Usage:
 *   <dolly-walkthrough mode="live" live-default="coach"></dolly-walkthrough>
 *   el.recording = myRecording;   // property (object) — preferred
 *   // or: <dolly-walkthrough recording='{...json...}'>  (attribute, for static HTML)
 *   el.play();  el.stop();
 *
 * The element renders a small control bar (play/stop + a "DOLLY is driving" banner in auto-run)
 * and hosts the DollyPlayer, which owns the video/overlay and the live driver.
 */
import type { Recording } from "@dolly/schema";
import { DollyPlayer, type StepEvent } from "./player.js";
import type { ResolvedMode } from "./driver.js";

const TAG = "dolly-walkthrough";

export class DollyWalkthroughElement extends HTMLElement {
  static observedAttributes = ["mode", "live-default"];

  private player: DollyPlayer | null = null;
  private _recording: Recording | null = null;
  private running = false;
  private root: ShadowRoot;
  private stage!: HTMLDivElement;
  private button!: HTMLButtonElement;
  private banner!: HTMLDivElement;
  private status!: HTMLDivElement;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = TEMPLATE;
  }

  connectedCallback(): void {
    this.stage = this.root.querySelector("[data-stage]") as HTMLDivElement;
    this.button = this.root.querySelector("[data-play]") as HTMLButtonElement;
    this.banner = this.root.querySelector("[data-banner]") as HTMLDivElement;
    this.status = this.root.querySelector("[data-status]") as HTMLDivElement;
    this.button.addEventListener("click", () => (this.running ? this.stop() : this.play()));

    // Allow a JSON recording supplied as an attribute for static-HTML embeds.
    if (!this._recording) {
      const raw = this.getAttribute("recording");
      if (raw) {
        try {
          this._recording = JSON.parse(raw) as Recording;
        } catch {
          this.setStatus("Invalid recording JSON");
        }
      }
    }
  }

  disconnectedCallback(): void {
    this.stop();
  }

  attributeChangedCallback(): void {
    // mode/live-default are read at play() time; nothing to do eagerly.
  }

  /** The recording to play. Setting a new one stops any run in progress. */
  get recording(): Recording | null {
    return this._recording;
  }
  set recording(rec: Recording | null) {
    this.stop();
    this._recording = rec;
  }

  private get mode(): "watch" | "live" {
    return this.getAttribute("mode") === "live" ? "live" : "watch";
  }
  private get liveDefault(): ResolvedMode {
    return this.getAttribute("live-default") === "auto" ? "auto" : "coach";
  }

  async play(): Promise<void> {
    if (this.running) return;
    if (!this._recording) {
      this.setStatus("No recording set");
      return;
    }
    const mode = this.getAttribute("mode") ? this.mode : this._recording.video ? "watch" : "live";
    this.running = true;
    this.button.textContent = "Stop";
    this.setDriving(mode === "live" && this.liveDefault === "auto");
    this.setStatus("");

    this.player = new DollyPlayer({
      recording: this._recording,
      mode,
      liveDefault: this.liveDefault,
      container: this.stage,
      videoUrl: this._recording.video ? this.getAttribute("video-url") ?? undefined : undefined,
      onStep: (e: StepEvent) => this.reportStep(e),
      onComplete: () => this.finish(),
    });
    try {
      await this.player.start();
    } finally {
      if (this.mode !== "live") this.finish();
    }
  }

  stop(): void {
    this.player?.stop();
    this.player = null;
    this.running = false;
    this.setDriving(false);
    if (this.button) this.button.textContent = "Play";
  }

  private finish(): void {
    this.running = false;
    this.setDriving(false);
    if (this.button) this.button.textContent = "Play";
    this.dispatchEvent(new CustomEvent("dolly-complete"));
  }

  private reportStep(e: StepEvent): void {
    const label = e.step.caption ?? e.step.action;
    if (e.status === "notfound") this.setStatus(`Couldn't locate: ${label} — skipping`);
    else if (e.status === "needsInput") this.setStatus(`Your turn: enter ${label}`);
    else if (e.status === "start") this.setStatus(label);
    this.dispatchEvent(new CustomEvent("dolly-step", { detail: e }));
  }

  private setDriving(on: boolean): void {
    if (this.banner) this.banner.style.display = on ? "flex" : "none";
  }
  private setStatus(text: string): void {
    if (this.status) this.status.textContent = text;
  }
}

const TEMPLATE = `
  <style>
    :host { display: block; font-family: system-ui, sans-serif; }
    .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    button {
      font: inherit; padding: 6px 16px; border-radius: 8px; border: 1px solid #2b3550;
      background: #2563eb; color: #fff; cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    .banner {
      display: none; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 999px;
      background: #7c2d12; color: #fed7aa; font-size: 13px; font-weight: 600;
    }
    .banner::before { content: "●"; color: #f97316; animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity: 0.3; } }
    .status { font-size: 13px; color: #94a3b8; min-height: 18px; }
    [data-stage] { position: relative; }
  </style>
  <div class="bar">
    <button data-play>Play</button>
    <div class="banner" data-banner>DOLLY is driving</div>
    <div class="status" data-status></div>
  </div>
  <div data-stage></div>
`;

/** Register the custom element (idempotent). Safe to call in non-browser contexts (no-op). */
export function registerWalkthroughElement(tag: string = TAG): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tag)) return;
  customElements.define(tag, DollyWalkthroughElement);
}
