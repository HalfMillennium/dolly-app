/**
 * A synthetic cursor overlay: a fixed, click-through canvas layered over the page on which the
 * player draws an animated cursor, click ripples, and a spotlight around the active element.
 *
 * This is a stateless renderer + lifecycle wrapper — the player owns the animation clock and
 * calls `render(state)` each frame. Browser runtime (no top-level DOM work, so it imports
 * cleanly under jsdom); not unit-tested (needs a real canvas).
 */
import { GLYPH_PX, GLYPH_UNITS, arrowPath } from "./glyph.js";

export interface OverlayState {
  /** cursor position in CSS px, or null to hide the cursor */
  cursor?: { x: number; y: number } | null;
  /** cursor size multiplier */
  size?: number;
  /** active click ripples (CSS px + progress 0..1) */
  ripples?: Array<{ x: number; y: number; p: number }>;
  /** spotlight rect in CSS px, or null for none */
  spotlight?: { x: number; y: number; w: number; h: number } | null;
  /** dim strength for the spotlight backdrop (0..1) */
  dim?: number;
}

export interface OverlayOptions {
  container?: HTMLElement;
  zIndex?: number;
}

const RIPPLE_MAX_PX = 46;

export class CursorOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private container: HTMLElement;
  private zIndex: number;
  private onResize = (): void => this.resize();

  constructor(opts: OverlayOptions = {}) {
    this.container = opts.container ?? document.body;
    this.zIndex = opts.zIndex ?? 2147483000;
  }

  mount(): void {
    if (this.canvas) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute(
      "style",
      `position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:${this.zIndex};`,
    );
    canvas.setAttribute("data-dolly-overlay", "");
    this.container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("scroll", this.onResize, true);
  }

  resize(): void {
    if (!this.canvas || !this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(state: OverlayState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    // spotlight: dim the page, cut a rounded hole around the active element, ring it
    if (state.spotlight) {
      const s = state.spotlight;
      const pad = 6;
      ctx.save();
      ctx.fillStyle = `rgba(10,14,20,${state.dim ?? 0.45})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "destination-out";
      roundRect(ctx, s.x - pad, s.y - pad, s.w + pad * 2, s.h + pad * 2, 8);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(120,170,255,0.95)";
      ctx.lineWidth = 2;
      roundRect(ctx, s.x - pad, s.y - pad, s.w + pad * 2, s.h + pad * 2, 8);
      ctx.stroke();
      ctx.restore();
    }

    // ripples
    for (const r of state.ripples ?? []) {
      const eased = 1 - Math.pow(1 - Math.min(1, Math.max(0, r.p)), 3); // cubicOut
      const radius = eased * RIPPLE_MAX_PX;
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - eased);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.01, radius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // cursor glyph
    if (state.cursor) {
      const glyph = arrowPath();
      const scale = ((GLYPH_PX / GLYPH_UNITS) * (state.size ?? 1));
      ctx.save();
      ctx.translate(state.cursor.x, state.cursor.y);
      ctx.scale(scale, scale);
      ctx.lineJoin = "round";
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = 1.5;
      if (glyph) {
        ctx.fill(glyph);
        ctx.stroke(glyph);
      }
      ctx.restore();
    }
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("scroll", this.onResize, true);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
