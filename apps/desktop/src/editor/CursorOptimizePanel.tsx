/**
 * AI-optimized cursor affordance ("Cursorcraft").
 *
 * "Optimized cursor — Adjust · Regenerate · Clear", a before/after toggle, a mode toggle
 * (path + clicks vs. full = also re-time the camera), the three sliders (speed / smoothness /
 * straightness), and an optional "Use AI director" switch (disabled until a Claude key is
 * configured). Mirrors AutoZoomPanel; wires to store.optimizeCursor.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_CONTROLS,
  summarizeForDirector,
  type CursorOptControls,
} from "@dolly/cursoropt";
import { useEditor } from "../state/store";
import { directorAvailable, optimizeDirector } from "../ipc/director";

export function CursorOptimizePanel() {
  const project = useEditor((s) => s.project);
  const cursor = useEditor((s) => s.cursor);
  const optimizeCursor = useEditor((s) => s.optimizeCursor);
  const clearCursorPath = useEditor((s) => s.clearCursorPath);
  const showOptimized = useEditor((s) => s.showOptimized);
  const setShowOptimized = useEditor((s) => s.setShowOptimized);

  const [controls, setControls] = useState<CursorOptControls>(DEFAULT_CONTROLS);
  const [adjust, setAdjust] = useState(false);
  const [useDirector, setUseDirector] = useState(false);
  const [directorReady, setDirectorReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    directorAvailable()
      .then((ok) => alive && setDirectorReady(ok))
      .catch(() => alive && setDirectorReady(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!project) return <div className="cursoropt cursoropt--empty">No project open</div>;

  const hasPath = !!project.cursorPath;
  const patch = (p: Partial<CursorOptControls>): void => setControls((c) => ({ ...c, ...p }));

  const meta = {
    duration: project.source.duration,
    aspect: project.source.width / project.source.height,
  };

  const regenerate = async (): Promise<void> => {
    setNote(null);
    if (useDirector && directorReady) {
      setBusy(true);
      try {
        const summary = summarizeForDirector(cursor, meta);
        const beats = await optimizeDirector(summary);
        optimizeCursor(controls, beats);
        setNote("Optimized with AI director");
      } catch {
        optimizeCursor(controls); // graceful fallback to the offline optimizer
        setNote("Director unavailable — used local optimizer");
      } finally {
        setBusy(false);
      }
      return;
    }
    optimizeCursor(controls);
  };

  return (
    <div className="cursoropt">
      <div className="cursoropt__headline">
        <strong>{hasPath ? "Optimized cursor" : "Optimize cursor (AI)"}</strong>
        <span className="cursoropt__actions">
          <button className="linkbtn" onClick={() => setAdjust((v) => !v)}>Adjust</button>
          <span>·</span>
          <button className="linkbtn" disabled={busy} onClick={() => void regenerate()}>
            {hasPath ? "Regenerate" : "Optimize"}
          </button>
          {hasPath && (
            <>
              <span>·</span>
              <button className="linkbtn" onClick={clearCursorPath}>Clear</button>
            </>
          )}
        </span>
      </div>

      {hasPath && (
        <label className="insp-row insp-row--inline">
          <input
            type="checkbox"
            checked={showOptimized}
            onChange={(e) => setShowOptimized(e.target.checked)}
          />
          <span>Show optimized (before / after)</span>
        </label>
      )}

      {note && <div className="cursoropt__note">{note}</div>}

      {adjust && (
        <div className="cursoropt__controls">
          <label className="insp-row">
            <span className="insp-row__label">Speed {controls.speed.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={controls.speed}
              onChange={(e) => patch({ speed: Number(e.target.value) })}
            />
          </label>
          <label className="insp-row">
            <span className="insp-row__label">Smoothness {controls.smoothness.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={controls.smoothness}
              onChange={(e) => patch({ smoothness: Number(e.target.value) })}
            />
          </label>
          <label className="insp-row">
            <span className="insp-row__label">Straightness {controls.straightness.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={controls.straightness}
              onChange={(e) => patch({ straightness: Number(e.target.value) })}
            />
          </label>
          <label className="insp-row insp-row--inline">
            <input
              type="checkbox"
              checked={controls.mode === "full"}
              onChange={(e) => patch({ mode: e.target.checked ? "full" : "pathClicks" })}
            />
            <span>Also re-time the zoom camera (full director)</span>
          </label>
          <label className="insp-row insp-row--inline" title={directorReady ? "" : "Add a Claude API key in Settings to enable"}>
            <input
              type="checkbox"
              disabled={!directorReady}
              checked={useDirector && directorReady}
              onChange={(e) => setUseDirector(e.target.checked)}
            />
            <span>Use AI director{directorReady ? "" : " (add a Claude API key to enable)"}</span>
          </label>
          <button className="btn" disabled={busy} onClick={() => void regenerate()}>
            {busy ? "Optimizing…" : "Apply"}
          </button>
        </div>
      )}
    </div>
  );
}
