/**
 * Canvas 2D preview renderer (BUILD_PLAN §6.3).
 *
 * Draw order is EXACT and shared with the native export path:
 *   fill backdrop
 *   → content rect (aspect-fit, shared math)
 *   → shadow rounded rect
 *   → clip rounded rect
 *   → zoom transform about focal (shared zoomTransform / zoomScaleAt)
 *   → drawImage(video)
 *   → synthetic cursor (scaled by 1/zoomScale)
 *   → unclip
 *   → editor overlays (suppressed when exportMode)
 *
 * ALL geometry/easing comes from `@dolly/schema/math`. The renderer never re-derives it — a
 * second implementation is exactly how preview/export drift starts (BUILD_PLAN §2.3, §6.6).
 */
import type {
  Backdrop,
  Composition,
  Project,
  Zoom,
} from "@dolly/schema";
import {
  clamp,
  contentRect,
  spring2DStep,
  zoomScaleAt,
  zoomTransform,
  type Rect,
  type Spring2D,
} from "@dolly/schema/math";
import { cursorPositionAt, drawCursor, smoothedPositionAt } from "./cursor";

/** Mutable render state the caller owns across frames (follow-focal spring + timing). */
export interface PreviewState {
  focal: Spring2D;
  lastTime: number | null;
  followInit: boolean;
}

export function createPreviewState(): PreviewState {
  return {
    focal: { x: { pos: 0.5, vel: 0 }, y: { pos: 0.5, vel: 0 } },
    lastTime: null,
    followInit: false,
  };
}

export interface RenderOptions {
  project: Project;
  /** current media time in seconds (absolute, not trimmed) */
  time: number;
  /** the proxy video frame source; null renders a placeholder */
  video: CanvasImageSource | null;
  /** canvas backing-store size in device pixels */
  width: number;
  height: number;
  cursor: import("@dolly/schema").CursorEvent[];
  state: PreviewState;
  /** suppress editor-only overlays; true when rendering for export parity */
  exportMode?: boolean;
  selectedZoomId?: string | null;
  /** render the AI-optimized cursor path (from project.cursorPath) instead of the raw track */
  showOptimized?: boolean;
}

/** The zoom active at time `t` (first whose [start,end] contains t), or null. */
function activeZoom(project: Project, t: number): Zoom | null {
  for (const z of project.zooms) {
    if (t >= z.start && t <= z.end) return z;
  }
  return null;
}

/** Effective zoom scale at time `t` (BUILD_PLAN §6.3), 1.0 when no zoom is active. */
export function scaleAt(project: Project, t: number): number {
  const z = activeZoom(project, t);
  return z ? zoomScaleAt(z, t) : 1;
}

/**
 * Effective focal (source-normalized, unclamped) at time `t`.
 * - fixed: hold the authored focal.
 * - follow: drive a critically-damped spring toward the smoothed cursor (shared spring2DStep).
 * `zoomTransform` clamps the focal for the current scale, so we return the raw value here.
 */
export function focalAt(
  project: Project,
  o: RenderOptions,
  dt: number,
): { x: number; y: number } {
  const z = activeZoom(project, o.time);
  if (!z) return { x: 0.5, y: 0.5 };

  if (z.focal.mode === "fixed") {
    return { x: z.focal.x, y: z.focal.y };
  }

  // follow mode
  const target =
    smoothedPositionAt(o.cursor, o.time, project.cursor.smoothing) ??
    cursorPositionAt(o.cursor, o.time) ?? { x: 0.5, y: 0.5 };

  if (!o.state.followInit || dt <= 0) {
    // (re)initialize on first frame or on a backward scrub
    o.state.focal = { x: { pos: target.x, vel: 0 }, y: { pos: target.y, vel: 0 } };
    o.state.followInit = true;
    return { x: target.x, y: target.y };
  }
  o.state.focal = spring2DStep(o.state.focal, target, z.focal.damping, Math.min(dt, 0.1));
  return { x: o.state.focal.x.pos, y: o.state.focal.y.pos };
}

// --- backdrop & rounded-rect helpers ---------------------------------------------------

function fillBackdrop(
  ctx: CanvasRenderingContext2D,
  b: Backdrop,
  w: number,
  h: number,
): void {
  if (b.type === "solid") {
    ctx.fillStyle = b.color;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const ang = (b.angle * Math.PI) / 180;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const cx = w / 2;
  const cy = h / 2;
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  g.addColorStop(0, b.from);
  g.addColorStop(1, b.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function roundRectPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rad = clamp(radius, 0, Math.min(r.w, r.h) / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.lineTo(r.x + r.w - rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + rad, rad);
  ctx.lineTo(r.x + r.w, r.y + r.h - rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x + r.w - rad, r.y + r.h, rad);
  ctx.lineTo(r.x + rad, r.y + r.h);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y + r.h - rad, rad);
  ctx.lineTo(r.x, r.y + rad);
  ctx.arcTo(r.x, r.y, r.x + rad, r.y, rad);
  ctx.closePath();
}

/** Composition radius is authored in output px; scale it into content/preview px. */
function scaledRadius(comp: Composition, content: Rect, project: Project): number {
  const outputW = project.source.width * project.source.scale;
  const ppx = outputW > 0 ? content.w / outputW : 1;
  return comp.radius * ppx;
}

// --- main entry ------------------------------------------------------------------------

export function renderPreview(ctx: CanvasRenderingContext2D, o: RenderOptions): void {
  const { project, width: W, height: H } = o;
  const comp = project.composition;

  const dt = o.state.lastTime === null ? 0 : o.time - o.state.lastTime;
  o.state.lastTime = o.time;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // 1. backdrop
  fillBackdrop(ctx, comp.backdrop, W, H);

  // 2. content rect (aspect-fit, shared math)
  const srcAspect = project.source.width / project.source.height;
  const content = contentRect(W, H, srcAspect, comp.padding);
  const radius = scaledRadius(comp, content, project);

  // 3. shadow rounded rect (outside the clip, so the blur shows around the frame)
  if (comp.shadow.enabled) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${clamp(comp.shadow.opacity, 0, 1)})`;
    ctx.shadowBlur = comp.shadow.blur;
    ctx.shadowOffsetY = comp.shadow.y;
    ctx.fillStyle = "#000000";
    roundRectPath(ctx, content, radius);
    ctx.fill();
    ctx.restore();
  }

  // 4. clip rounded rect
  ctx.save();
  roundRectPath(ctx, content, radius);
  ctx.clip();

  // opaque base under the video (letterbox / while proxy loads)
  ctx.fillStyle = "#0b0e12";
  ctx.fillRect(content.x, content.y, content.w, content.h);

  // 5. zoom transform about focal (shared math)
  const s = scaleAt(project, o.time);
  const focal = focalAt(project, o, dt);
  const m = zoomTransform(content, s, focal);

  ctx.save();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

  // 6. drawImage(video)
  if (o.video) {
    ctx.drawImage(o.video, content.x, content.y, content.w, content.h);
  } else {
    drawPlaceholder(ctx, content);
  }

  // 7. synthetic cursor (scaled by 1/zoomScale, inside the zoom transform). When enabled,
  // follows the AI-optimized path (project.cursorPath) instead of the raw telemetry track.
  if (project.cursor.visible) {
    drawCursor(ctx, o.cursor, o.time, project.cursor, s, content, {
      path: project.cursorPath ?? null,
      useOptimized: o.showOptimized ?? false,
    });
  }

  ctx.restore(); // undo zoom transform
  ctx.restore(); // 8. unclip

  // 9. editor overlays — MUST NOT appear in export
  if (!o.exportMode) {
    drawOverlays(ctx, o, content, s, focal);
  }

  ctx.restore();
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, content: Rect): void {
  ctx.fillStyle = "#12171d";
  ctx.fillRect(content.x, content.y, content.w, content.h);
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.font = `${Math.round(content.h * 0.05)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("proxy.mp4", content.x + content.w / 2, content.y + content.h / 2);
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  o: RenderOptions,
  content: Rect,
  scale: number,
  focal: { x: number; y: number },
): void {
  // content bounds
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.strokeRect(content.x + 0.5, content.y + 0.5, content.w - 1, content.h - 1);
  ctx.restore();

  // focal crosshair when a zoom is active
  if (scale > 1.0001) {
    const fx = content.x + focal.x * content.w;
    const fy = content.y + focal.y * content.h;
    ctx.save();
    ctx.strokeStyle = "rgba(120,200,255,0.9)";
    ctx.fillStyle = "rgba(120,200,255,0.18)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(fx, fy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(fx - 16, fy);
    ctx.lineTo(fx + 16, fy);
    ctx.moveTo(fx, fy - 16);
    ctx.lineTo(fx, fy + 16);
    ctx.stroke();
    ctx.restore();
  }
}
