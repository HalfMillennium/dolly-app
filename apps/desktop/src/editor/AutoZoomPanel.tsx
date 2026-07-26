/**
 * Auto-zoom affordance (BUILD_PLAN §6.4).
 *
 * "Added N zooms — Adjust · Regenerate · Clear", the three user controls (intensity,
 * smoothness, "zoom on clicks only"), all wired to store.runAutoZoom, plus an optional
 * collapsed debug section exposing the resolved raw params.
 */
import { useState } from "react";
import {
  DEFAULT_CONTROLS,
  paramsFromControls,
  type AutoZoomControls,
} from "@dolly/autozoom";
import { useEditor } from "../state/store";

export function AutoZoomPanel() {
  const project = useEditor((s) => s.project);
  const runAutoZoom = useEditor((s) => s.runAutoZoom);
  const removeZoom = useEditor((s) => s.removeZoom);

  const [controls, setControls] = useState<AutoZoomControls>(DEFAULT_CONTROLS);
  const [adjust, setAdjust] = useState(false);
  const [debug, setDebug] = useState(false);

  if (!project) return <div className="autozoom autozoom--empty">No project open</div>;

  const autoCount = project.zooms.filter((z) => z.origin === "auto").length;

  const patch = (p: Partial<AutoZoomControls>): void =>
    setControls((c) => ({ ...c, ...p }));

  const regenerate = (): void => runAutoZoom(controls);
  const clearAuto = (): void => {
    for (const z of project.zooms.filter((z) => z.origin === "auto")) removeZoom(z.id);
  };

  const resolved = paramsFromControls(controls);

  return (
    <div className="autozoom">
      <div className="autozoom__headline">
        <strong>Added {autoCount} zoom{autoCount === 1 ? "" : "s"}</strong>
        <span className="autozoom__actions">
          <button className="linkbtn" onClick={() => setAdjust((v) => !v)}>Adjust</button>
          <span>·</span>
          <button className="linkbtn" onClick={regenerate}>Regenerate</button>
          <span>·</span>
          <button className="linkbtn" onClick={clearAuto}>Clear</button>
        </span>
      </div>

      {adjust && (
        <div className="autozoom__controls">
          <label className="insp-row">
            <span className="insp-row__label">Intensity {controls.intensity.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={controls.intensity}
              onChange={(e) => patch({ intensity: Number(e.target.value) })}
            />
          </label>
          <label className="insp-row">
            <span className="insp-row__label">Smoothness {controls.smoothness.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={controls.smoothness}
              onChange={(e) => patch({ smoothness: Number(e.target.value) })}
            />
          </label>
          <label className="insp-row insp-row--inline">
            <input
              type="checkbox"
              checked={controls.clicksOnly}
              onChange={(e) => patch({ clicksOnly: e.target.checked })}
            />
            <span>Zoom on clicks only</span>
          </label>
          <button className="btn" onClick={regenerate}>Apply</button>

          <button className="linkbtn autozoom__debugtoggle" onClick={() => setDebug((v) => !v)}>
            {debug ? "▾" : "▸"} Debug params
          </button>
          {debug && (
            <pre className="autozoom__debug">{JSON.stringify(resolved, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
