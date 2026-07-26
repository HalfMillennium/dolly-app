/**
 * Editor shell (BUILD_PLAN §6). Wires the stage, timeline, inspector and auto-zoom panel to
 * the store, provides transport + undo/redo, and an empty state when no project is open.
 */
import { useEffect } from "react";
import { useEditor } from "./state/store";
import { demoCursor, demoProject } from "./state/demo";
import { Stage } from "./editor/Stage";
import { Timeline } from "./editor/Timeline";
import { Inspector } from "./editor/Inspector";
import { AutoZoomPanel } from "./editor/AutoZoomPanel";

export function App() {
  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setProject = useEditor((s) => s.setProject);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const addZoom = useEditor((s) => s.addZoom);

  // keyboard: space = play/pause, cmd/ctrl+z = undo, shift+cmd/ctrl+z = redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useEditor.getState().playing);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, setPlaying, undo]);

  if (!project) {
    return (
      <div className="app app--empty">
        <div className="empty">
          <h1>DOLLY</h1>
          <p>No project open.</p>
          <button
            className="btn btn--primary"
            onClick={() => setProject(demoProject, demoCursor())}
          >
            Open demo project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app__bar">
        <div className="app__title">DOLLY</div>
        <div className="app__transport">
          <button className="btn" onClick={() => setPlaying(!playing)}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button className="btn" onClick={() => addZoom()}>+ Zoom</button>
          <button className="btn" onClick={undo}>↶ Undo</button>
          <button className="btn" onClick={redo}>↷ Redo</button>
          <span className="app__time">
            {playhead.toFixed(2)}s / {project.source.duration.toFixed(0)}s
          </span>
          <input
            type="range"
            className="app__scrub"
            min={0}
            max={project.source.duration}
            step={0.01}
            value={playhead}
            onChange={(e) => setPlayhead(Number(e.target.value))}
          />
        </div>
        <button className="btn" onClick={() => setProject(null)}>Close</button>
      </header>

      <div className="app__main">
        <div className="app__left">
          <Stage />
          <AutoZoomPanel />
          <Timeline />
        </div>
        <aside className="app__right">
          <Inspector />
        </aside>
      </div>
    </div>
  );
}
