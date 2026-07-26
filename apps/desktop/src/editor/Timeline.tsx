/**
 * DOM timeline (BUILD_PLAN §6.1 — absolutely-positioned divs, not canvas).
 *
 * A ruler, a track of zoom segments (drag to move, edge handles to resize — wired to
 * store.updateZoom), the playhead, and trim handles. auto vs manual origin is shown by color.
 */
import { useCallback, useRef } from "react";
import type { Zoom } from "@dolly/schema";
import { useEditor } from "../state/store";

type DragKind = "move" | "resize-l" | "resize-r" | "trim-in" | "trim-out" | "scrub";

interface DragCtx {
  kind: DragKind;
  id?: string;
  startX: number;
  origStart: number;
  origEnd: number;
  pxPerSec: number;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selectedZoomId = useEditor((s) => s.selectedZoomId);
  const updateZoom = useEditor((s) => s.updateZoom);
  const setTrim = useEditor((s) => s.setTrim);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const select = useEditor((s) => s.select);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragCtx | null>(null);

  const duration = project?.source.duration ?? 0;

  const pxPerSec = useCallback((): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 1;
    return el.clientWidth / duration;
  }, [duration]);

  const timeFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const t = ((clientX - rect.left) / rect.width) * duration;
      return Math.max(0, Math.min(duration, t));
    },
    [duration],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dt = (e.clientX - d.startX) / d.pxPerSec;
      switch (d.kind) {
        case "scrub":
          setPlayhead(timeFromEvent(e.clientX));
          break;
        case "trim-in":
          setTrim({ in: clampT(d.origStart + dt, 0, d.origEnd - 0.1) });
          break;
        case "trim-out":
          setTrim({ out: clampT(d.origEnd + dt, d.origStart + 0.1, duration) });
          break;
        case "move":
          if (d.id) {
            const len = d.origEnd - d.origStart;
            const start = clampT(d.origStart + dt, 0, duration - len);
            updateZoom(d.id, { start, end: start + len });
          }
          break;
        case "resize-l":
          if (d.id) updateZoom(d.id, { start: clampT(d.origStart + dt, 0, d.origEnd - 0.3) });
          break;
        case "resize-r":
          if (d.id) updateZoom(d.id, { end: clampT(d.origEnd + dt, d.origStart + 0.3, duration) });
          break;
      }
    },
    [duration, setPlayhead, setTrim, timeFromEvent, updateZoom],
  );

  const endDrag = useCallback((): void => {
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  const beginDrag = useCallback(
    (kind: DragKind, e: React.PointerEvent, z?: Zoom): void => {
      e.stopPropagation();
      const t = project?.trim;
      drag.current = {
        kind,
        id: z?.id,
        startX: e.clientX,
        origStart: z?.start ?? t?.in ?? 0,
        origEnd: z?.end ?? t?.out ?? duration,
        pxPerSec: pxPerSec(),
      };
      if (z) select(z.id);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
    },
    [duration, endDrag, onPointerMove, project?.trim, pxPerSec, select],
  );

  if (!project) {
    return <div className="timeline timeline--empty">No project open</div>;
  }

  const pct = (t: number): string => `${(t / Math.max(0.0001, duration)) * 100}%`;
  const ticks = buildTicks(duration);

  return (
    <div className="timeline">
      <div className="timeline__ruler" onPointerDown={(e) => beginDrag("scrub", e)}>
        {ticks.map((t) => (
          <div key={t} className="timeline__tick" style={{ left: pct(t) }}>
            <span>{fmt(t)}</span>
          </div>
        ))}
      </div>

      <div
        className="timeline__track"
        ref={trackRef}
        onPointerDown={(e) => beginDrag("scrub", e)}
      >
        {/* trimmed-out regions */}
        <div className="timeline__trimmed" style={{ left: 0, width: pct(project.trim.in) }} />
        <div
          className="timeline__trimmed"
          style={{ left: pct(project.trim.out), right: 0 }}
        />

        {project.zooms.map((z) => (
          <div
            key={z.id}
            className={
              "timeline__zoom" +
              (z.origin === "auto" ? " is-auto" : " is-manual") +
              (z.id === selectedZoomId ? " is-selected" : "")
            }
            style={{ left: pct(z.start), width: pct(z.end - z.start) }}
            onPointerDown={(e) => beginDrag("move", e, z)}
            title={`${z.origin} · ${z.scale.toFixed(1)}× · ${z.focal.mode}`}
          >
            <div
              className="timeline__handle timeline__handle--l"
              onPointerDown={(e) => beginDrag("resize-l", e, z)}
            />
            <span className="timeline__zoom-label">
              {z.scale.toFixed(1)}× {z.focal.mode === "follow" ? "⤳" : "◎"}
            </span>
            <div
              className="timeline__handle timeline__handle--r"
              onPointerDown={(e) => beginDrag("resize-r", e, z)}
            />
          </div>
        ))}

        {/* trim handles */}
        <div
          className="timeline__trim timeline__trim--in"
          style={{ left: pct(project.trim.in) }}
          onPointerDown={(e) => beginDrag("trim-in", e)}
        />
        <div
          className="timeline__trim timeline__trim--out"
          style={{ left: pct(project.trim.out) }}
          onPointerDown={(e) => beginDrag("trim-out", e)}
        />

        {/* playhead */}
        <div className="timeline__playhead" style={{ left: pct(playhead) }} />
      </div>
    </div>
  );
}

function clampT(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function buildTicks(duration: number): number[] {
  if (duration <= 0) return [0];
  const step = duration <= 30 ? 5 : duration <= 120 ? 10 : 30;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) out.push(Math.round(t));
  return out;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
