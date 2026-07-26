/**
 * Inspector: controls for the selected zoom (scale, ramps, focal mode, easing) and the
 * composition (backdrop, padding, radius, shadow) plus cursor style. All edits go through the
 * store; editing an auto zoom flips it to manual (§3.3, handled in store.updateZoom).
 */
import type {
  Backdrop,
  CursorStyle,
  ZoomEasing,
  ZoomFocal,
} from "@dolly/schema";
import { useEditor, useSelectedZoom } from "../state/store";

export function Inspector() {
  const project = useEditor((s) => s.project);
  const zoom = useSelectedZoom();
  const updateZoom = useEditor((s) => s.updateZoom);
  const updateComposition = useEditor((s) => s.updateComposition);
  const updateCursorStyle = useEditor((s) => s.updateCursorStyle);
  const removeZoom = useEditor((s) => s.removeZoom);

  if (!project) return <div className="inspector inspector--empty">No project open</div>;

  const comp = project.composition;
  const cur = project.cursor;

  return (
    <div className="inspector">
      <section className="insp-section">
        <h3>Zoom</h3>
        {!zoom ? (
          <p className="insp-hint">Select a zoom segment in the timeline.</p>
        ) : (
          <div className="insp-grid">
            <span className={"insp-badge " + (zoom.origin === "auto" ? "is-auto" : "is-manual")}>
              {zoom.origin}
            </span>
            <Row label={`Scale ${zoom.scale.toFixed(2)}×`}>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom.scale}
                onChange={(e) => updateZoom(zoom.id, { scale: Number(e.target.value) })}
              />
            </Row>
            <Row label={`Ramp in ${zoom.rampIn.toFixed(2)}s`}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={zoom.rampIn}
                onChange={(e) => updateZoom(zoom.id, { rampIn: Number(e.target.value) })}
              />
            </Row>
            <Row label={`Ramp out ${zoom.rampOut.toFixed(2)}s`}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={zoom.rampOut}
                onChange={(e) => updateZoom(zoom.id, { rampOut: Number(e.target.value) })}
              />
            </Row>
            <Row label="Easing">
              <select
                value={zoom.easing}
                onChange={(e) =>
                  updateZoom(zoom.id, { easing: e.target.value as ZoomEasing })
                }
              >
                <option value="cubicInOut">cubicInOut</option>
                <option value="cubicOut">cubicOut</option>
                <option value="linear">linear</option>
              </select>
            </Row>
            <Row label="Focal mode">
              <select
                value={zoom.focal.mode}
                onChange={(e) =>
                  updateZoom(zoom.id, { focal: makeFocal(e.target.value, zoom.focal) })
                }
              >
                <option value="fixed">fixed</option>
                <option value="follow">follow (cursor)</option>
              </select>
            </Row>
            {zoom.focal.mode === "fixed" ? (
              <>
                <Row label={`Focal X ${zoom.focal.x.toFixed(2)}`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={zoom.focal.x}
                    onChange={(e) =>
                      updateZoom(zoom.id, {
                        focal: { mode: "fixed", x: Number(e.target.value), y: focalY(zoom.focal) },
                      })
                    }
                  />
                </Row>
                <Row label={`Focal Y ${zoom.focal.y.toFixed(2)}`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={zoom.focal.y}
                    onChange={(e) =>
                      updateZoom(zoom.id, {
                        focal: { mode: "fixed", x: focalX(zoom.focal), y: Number(e.target.value) },
                      })
                    }
                  />
                </Row>
              </>
            ) : (
              <Row label={`Damping ${zoom.focal.damping.toFixed(2)}`}>
                <input
                  type="range"
                  min={0.05}
                  max={0.5}
                  step={0.01}
                  value={zoom.focal.damping}
                  onChange={(e) =>
                    updateZoom(zoom.id, {
                      focal: { mode: "follow", damping: Number(e.target.value), track: "cursor" },
                    })
                  }
                />
              </Row>
            )}
            <button className="btn btn--danger" onClick={() => removeZoom(zoom.id)}>
              Delete zoom
            </button>
          </div>
        )}
      </section>

      <section className="insp-section">
        <h3>Composition</h3>
        <div className="insp-grid">
          <Row label="Backdrop">
            <select
              value={comp.backdrop.type}
              onChange={(e) =>
                updateComposition({ backdrop: makeBackdrop(e.target.value, comp.backdrop) })
              }
            >
              <option value="gradient">gradient</option>
              <option value="solid">solid</option>
            </select>
          </Row>
          {comp.backdrop.type === "gradient" ? (
            <>
              <Row label="From">
                <input
                  type="color"
                  value={comp.backdrop.from}
                  onChange={(e) =>
                    updateComposition({ backdrop: { ...gradient(comp.backdrop), from: e.target.value } })
                  }
                />
              </Row>
              <Row label="To">
                <input
                  type="color"
                  value={comp.backdrop.to}
                  onChange={(e) =>
                    updateComposition({ backdrop: { ...gradient(comp.backdrop), to: e.target.value } })
                  }
                />
              </Row>
              <Row label={`Angle ${comp.backdrop.angle}°`}>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={comp.backdrop.angle}
                  onChange={(e) =>
                    updateComposition({ backdrop: { ...gradient(comp.backdrop), angle: Number(e.target.value) } })
                  }
                />
              </Row>
            </>
          ) : (
            <Row label="Color">
              <input
                type="color"
                value={comp.backdrop.color}
                onChange={(e) =>
                  updateComposition({ backdrop: { type: "solid", color: e.target.value } })
                }
              />
            </Row>
          )}
          <Row label={`Padding ${(comp.padding * 100).toFixed(0)}%`}>
            <input
              type="range"
              min={0}
              max={0.25}
              step={0.005}
              value={comp.padding}
              onChange={(e) => updateComposition({ padding: Number(e.target.value) })}
            />
          </Row>
          <Row label={`Radius ${comp.radius}px`}>
            <input
              type="range"
              min={0}
              max={64}
              step={1}
              value={comp.radius}
              onChange={(e) => updateComposition({ radius: Number(e.target.value) })}
            />
          </Row>
          <Row label="Shadow">
            <input
              type="checkbox"
              checked={comp.shadow.enabled}
              onChange={(e) =>
                updateComposition({ shadow: { ...comp.shadow, enabled: e.target.checked } })
              }
            />
          </Row>
          <Row label={`Shadow opacity ${comp.shadow.opacity.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={comp.shadow.opacity}
              onChange={(e) =>
                updateComposition({ shadow: { ...comp.shadow, opacity: Number(e.target.value) } })
              }
            />
          </Row>
          <Row label={`Shadow blur ${comp.shadow.blur}px`}>
            <input
              type="range"
              min={0}
              max={120}
              step={1}
              value={comp.shadow.blur}
              onChange={(e) =>
                updateComposition({ shadow: { ...comp.shadow, blur: Number(e.target.value) } })
              }
            />
          </Row>
          <Row label={`Shadow Y ${comp.shadow.y}px`}>
            <input
              type="range"
              min={-40}
              max={60}
              step={1}
              value={comp.shadow.y}
              onChange={(e) =>
                updateComposition({ shadow: { ...comp.shadow, y: Number(e.target.value) } })
              }
            />
          </Row>
        </div>
      </section>

      <section className="insp-section">
        <h3>Cursor</h3>
        <div className="insp-grid">
          <Row label="Visible">
            <input
              type="checkbox"
              checked={cur.visible}
              onChange={(e) => updateCursorStyle({ visible: e.target.checked })}
            />
          </Row>
          <Row label={`Size ${cur.size.toFixed(2)}×`}>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.05}
              value={cur.size}
              onChange={(e) => setCursorNum(updateCursorStyle, "size", e.target.value)}
            />
          </Row>
          <Row label={`Smoothing ${cur.smoothing.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={cur.smoothing}
              onChange={(e) => setCursorNum(updateCursorStyle, "smoothing", e.target.value)}
            />
          </Row>
          <Row label="Click ripple">
            <input
              type="checkbox"
              checked={cur.clickRipple}
              onChange={(e) => updateCursorStyle({ clickRipple: e.target.checked })}
            />
          </Row>
          <Row label={`Hide when idle ${cur.hideWhenIdle.toFixed(1)}s`}>
            <input
              type="range"
              min={0}
              max={5}
              step={0.5}
              value={cur.hideWhenIdle}
              onChange={(e) => setCursorNum(updateCursorStyle, "hideWhenIdle", e.target.value)}
            />
          </Row>
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="insp-row">
      <span className="insp-row__label">{label}</span>
      <span className="insp-row__control">{children}</span>
    </label>
  );
}

function setCursorNum(
  update: (patch: Partial<CursorStyle>) => void,
  key: "size" | "smoothing" | "hideWhenIdle",
  value: string,
): void {
  update({ [key]: Number(value) } as Partial<CursorStyle>);
}

function focalX(f: ZoomFocal): number {
  return f.mode === "fixed" ? f.x : 0.5;
}
function focalY(f: ZoomFocal): number {
  return f.mode === "fixed" ? f.y : 0.5;
}

function makeFocal(mode: string, prev: ZoomFocal): ZoomFocal {
  if (mode === "follow") {
    return { mode: "follow", damping: prev.mode === "follow" ? prev.damping : 0.12, track: "cursor" };
  }
  return { mode: "fixed", x: focalX(prev), y: focalY(prev) };
}

function gradient(b: Backdrop): { type: "gradient"; from: string; to: string; angle: number } {
  return b.type === "gradient" ? b : { type: "gradient", from: "#2A3138", to: "#151A1F", angle: 135 };
}

function makeBackdrop(type: string, prev: Backdrop): Backdrop {
  if (type === "solid") {
    return { type: "solid", color: prev.type === "solid" ? prev.color : "#1A1F24" };
  }
  return gradient(prev);
}
