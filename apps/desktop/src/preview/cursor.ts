/**
 * Synthetic cursor (BUILD_PLAN §6.5).
 *
 * Rendered from the cursor telemetry track, identically in preview and export: One Euro
 * filtered position (shared math), bundled SVG arrow / I-beam glyphs as Path2D, size scaled
 * by `cursor.size × (1/zoomScale)`, click ripple (expanding ring, 350ms, cubicOut, opacity
 * 0.5→0), and a `hideWhenIdle` fade.
 *
 * All geometry/easing comes from `@dolly/schema/math` — nothing here re-derives it.
 */
import type { CursorEvent, CursorStyle } from "@dolly/schema";
import { OneEuroFilter, cubicOut, type Rect } from "@dolly/schema/math";

/** Nominal on-screen glyph height in canvas px, before cursor.size / zoom scaling. */
const GLYPH_PX = 22;
/** The glyph paths are authored in a 24×24 box. */
const GLYPH_UNITS = 24;
const RIPPLE_MS = 350;
const RIPPLE_MAX_PX = 46;
const IDLE_FADE = 0.5; // seconds to fade out once idle threshold is crossed

// macOS-ish arrow, authored in a 24×24 box, tip at the origin corner.
const ARROW_PATH = new Path2D(
  "M2 1 L2 20 L7 15.5 L10.4 22 L13 20.8 L9.7 14.6 L15.5 14.6 Z",
);
// Text I-beam (stroked), also 24×24.
const IBEAM_PATH = new Path2D(
  "M8 3 L16 3 M8 21 L16 21 M12 3 L12 21",
);

export interface CursorPoint {
  x: number;
  y: number;
}

/** Linearly-interpolated raw cursor position (normalized) at time `t`, or null if unknown. */
export function cursorPositionAt(cursor: CursorEvent[], t: number): CursorPoint | null {
  let prev: CursorEvent | null = null;
  let next: CursorEvent | null = null;
  for (const e of cursor) {
    if (e.x === undefined || e.y === undefined) continue;
    if (e.t <= t) {
      prev = e;
    } else {
      next = e;
      break;
    }
  }
  if (prev && prev.x !== undefined && prev.y !== undefined) {
    if (next && next.x !== undefined && next.y !== undefined && next.t > prev.t) {
      const f = (t - prev.t) / (next.t - prev.t);
      return {
        x: prev.x + (next.x - prev.x) * f,
        y: prev.y + (next.y - prev.y) * f,
      };
    }
    return { x: prev.x, y: prev.y };
  }
  if (next && next.x !== undefined && next.y !== undefined) {
    return { x: next.x, y: next.y };
  }
  return null;
}

/**
 * One Euro filtered position at time `t` (BUILD_PLAN §6.4 step 1 / §6.5). Stateless: runs the
 * filter over the trailing window so the same `t` always yields the same point (matches the
 * deterministic export path). `smoothing` (0..1) widens the window and lowers the cutoff.
 */
export function smoothedPositionAt(
  cursor: CursorEvent[],
  t: number,
  smoothing: number,
): CursorPoint | null {
  const window = 0.35 + smoothing * 0.65; // seconds of trailing context
  const minCutoff = Math.max(0.3, 1.0 - smoothing * 0.7);
  const fx = new OneEuroFilter(minCutoff, 0.02);
  const fy = new OneEuroFilter(minCutoff, 0.02);
  let out: CursorPoint | null = null;
  const start = t - window;
  const step = 1 / 60;
  for (let s = start; s <= t + 1e-6; s += step) {
    const p = cursorPositionAt(cursor, s);
    if (!p) continue;
    out = { x: fx.filter(p.x, s), y: fy.filter(p.y, s) };
  }
  return out ?? cursorPositionAt(cursor, t);
}

/** Time (seconds) of the most recent activity at or before `t`, or null. */
function lastActivityBefore(cursor: CursorEvent[], t: number): number | null {
  let best: number | null = null;
  for (const e of cursor) {
    if (e.t > t) break;
    if (e.e === "move" || e.e === "drag" || e.e === "down" || e.e === "scroll") {
      best = e.t;
    }
  }
  return best;
}

/**
 * Draw the synthetic cursor for the current frame.
 *
 * Must be called WHILE the §6.3 zoom transform is active: positions are in content-rect
 * coordinates and the glyph is drawn at `1/zoomScale` so it stays a constant on-screen size.
 */
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  cursor: CursorEvent[],
  time: number,
  style: CursorStyle,
  zoomScale: number,
  content: Rect,
): void {
  if (!style.visible) return;

  const pos = smoothedPositionAt(cursor, time, style.smoothing);
  if (!pos) return;

  // hideWhenIdle fade
  let alpha = 1;
  if (style.hideWhenIdle > 0) {
    const last = lastActivityBefore(cursor, time);
    if (last !== null) {
      const idle = time - last;
      if (idle > style.hideWhenIdle) {
        alpha = Math.max(0, 1 - (idle - style.hideWhenIdle) / IDLE_FADE);
      }
    }
  }
  if (alpha <= 0) return;

  const px = content.x + pos.x * content.w;
  const py = content.y + pos.y * content.h;

  // Screen size held constant: counter the zoom, apply user size.
  const glyphScale = (GLYPH_PX / GLYPH_UNITS) * style.size / zoomScale;

  // --- click ripple(s) (drawn under the glyph) ---
  if (style.clickRipple) {
    for (const e of cursor) {
      if (e.e !== "down" || e.x === undefined || e.y === undefined) continue;
      const age = (time - e.t) * 1000;
      if (age < 0 || age > RIPPLE_MS) continue;
      const k = age / RIPPLE_MS;
      const eased = cubicOut(k);
      const radius = (eased * RIPPLE_MAX_PX) / zoomScale;
      const rippleAlpha = 0.5 * (1 - eased) * alpha;
      const rx = content.x + e.x * content.w;
      const ry = content.y + e.y * content.h;
      ctx.save();
      ctx.globalAlpha = rippleAlpha;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3 / zoomScale;
      ctx.beginPath();
      ctx.arc(rx, ry, Math.max(0.01, radius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- glyph ---
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(px, py);
  ctx.scale(glyphScale, glyphScale);
  ctx.lineJoin = "round";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.5;
  ctx.fill(ARROW_PATH);
  ctx.stroke(ARROW_PATH);
  ctx.restore();
}

/** Exposed so the export renderer can reuse the identical glyphs (parity, §6.6). */
export const CURSOR_GLYPHS = { arrow: ARROW_PATH, ibeam: IBEAM_PATH };
