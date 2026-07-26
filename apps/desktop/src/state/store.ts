/**
 * Editor store (BUILD_PLAN §6.1).
 *
 * Zustand store holding the Project plus transient editor UI state (playhead, selection,
 * playing). Every project mutation goes through `commit`, which uses immer's
 * `produceWithPatches` to record forward + inverse patches. Those drive undo/redo, with the
 * past/future stacks capped at 200.
 */
import { create } from "zustand";
import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from "immer";
import type {
  Composition,
  CursorEvent,
  CursorStyle,
  Project,
  Trim,
  Zoom,
  ZoomFocal,
} from "@dolly/schema";
import {
  DEFAULT_CONTROLS,
  generateZoomsFromControls,
  mergeAuto,
  type AutoZoomControls,
} from "@dolly/autozoom";

enablePatches();

const HISTORY_CAP = 200;

interface HistoryEntry {
  patches: Patch[];
  inverse: Patch[];
}

function capPush(stack: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = stack.length >= HISTORY_CAP ? stack.slice(1) : stack.slice();
  next.push(entry);
  return next;
}

let zoomSeq = 0;
function nextZoomId(prefix: string): string {
  zoomSeq += 1;
  return `${prefix}${Date.now().toString(36)}${zoomSeq}`;
}

export interface EditorState {
  project: Project | null;
  /** parsed cursor.jsonl for the open project; drives auto-zoom and the synthetic cursor */
  cursor: CursorEvent[];
  playhead: number;
  selectedZoomId: string | null;
  playing: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];

  // --- transient UI (not undoable) ---
  setProject: (project: Project | null, cursor?: CursorEvent[]) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  select: (id: string | null) => void;

  // --- undoable project mutations ---
  updateComposition: (patch: Partial<Composition>) => void;
  updateCursorStyle: (patch: Partial<CursorStyle>) => void;
  setTrim: (patch: Partial<Trim>) => void;
  addZoom: (partial?: Partial<Zoom>) => void;
  updateZoom: (id: string, patch: Partial<Zoom>) => void;
  removeZoom: (id: string) => void;
  runAutoZoom: (controls?: AutoZoomControls) => void;

  undo: () => void;
  redo: () => void;
}

export const useEditor = create<EditorState>((set, get) => {
  /** Run an immer recipe against the current project, recording patches for undo/redo. */
  const commit = (recipe: (draft: Project) => void): void => {
    const state = get();
    if (!state.project) return;
    const [next, patches, inverse] = produceWithPatches(state.project, recipe);
    if (patches.length === 0) return;
    set({
      project: next,
      past: capPush(state.past, { patches, inverse }),
      future: [],
    });
  };

  return {
    project: null,
    cursor: [],
    playhead: 0,
    selectedZoomId: null,
    playing: false,
    past: [],
    future: [],

    setProject: (project, cursor = []) =>
      set({
        project,
        cursor,
        playhead: project ? project.trim.in : 0,
        selectedZoomId: null,
        playing: false,
        past: [],
        future: [],
      }),

    setPlayhead: (t) => set({ playhead: t }),
    setPlaying: (playing) => set({ playing }),
    select: (id) => set({ selectedZoomId: id }),

    updateComposition: (patch) =>
      commit((d) => {
        d.composition = { ...d.composition, ...patch };
      }),

    updateCursorStyle: (patch) =>
      commit((d) => {
        d.cursor = { ...d.cursor, ...patch };
      }),

    setTrim: (patch) =>
      commit((d) => {
        d.trim = { ...d.trim, ...patch };
      }),

    addZoom: (partial) => {
      const state = get();
      const project = state.project;
      if (!project) return;
      const start = partial?.start ?? state.playhead;
      const end =
        partial?.end ?? Math.min(start + 3, project.trim.out, project.source.duration);
      const id = partial?.id ?? nextZoomId("m");
      const zoom: Zoom = {
        id,
        start,
        end: Math.max(end, start + 0.5),
        scale: 2,
        focal: { mode: "fixed", x: 0.5, y: 0.5 },
        rampIn: 0.45,
        rampOut: 0.6,
        easing: "cubicInOut",
        origin: "manual",
        ...partial,
        // id is authoritative even if `partial` omitted it
      };
      zoom.id = id;
      commit((d) => {
        d.zooms.push(zoom);
        d.zooms.sort((a, b) => a.start - b.start);
      });
      set({ selectedZoomId: id });
    },

    updateZoom: (id, patch) =>
      commit((d) => {
        const z = d.zooms.find((zoom) => zoom.id === id);
        if (!z) return;
        Object.assign(z, patch);
        // A user edit to an auto segment flips it to manual (BUILD_PLAN §3.3).
        if (z.origin === "auto" && patch.origin === undefined) {
          z.origin = "manual";
        }
        if (z.end < z.start) {
          const s = z.start;
          z.start = z.end;
          z.end = s;
        }
        d.zooms.sort((a, b) => a.start - b.start);
      }),

    removeZoom: (id) => {
      commit((d) => {
        const i = d.zooms.findIndex((z) => z.id === id);
        if (i >= 0) d.zooms.splice(i, 1);
      });
      if (get().selectedZoomId === id) set({ selectedZoomId: null });
    },

    runAutoZoom: (controls = DEFAULT_CONTROLS) => {
      const state = get();
      const project = state.project;
      if (!project) return;
      const meta = {
        duration: project.source.duration,
        aspect: project.source.width / project.source.height,
      };
      const fresh = generateZoomsFromControls(state.cursor, meta, controls);
      const merged = mergeAuto(project.zooms, fresh);
      commit((d) => {
        d.zooms = merged;
        d.autoZoom = {
          lastRunParams: { ...controls },
          generatedAt: new Date().toISOString(),
        };
      });
    },

    undo: () => {
      const { project, past, future } = get();
      if (!project) return;
      const entry = past.at(-1);
      if (!entry) return;
      set({
        project: applyPatches(project, entry.inverse),
        past: past.slice(0, -1),
        future: capPush(future, entry),
      });
    },

    redo: () => {
      const { project, past, future } = get();
      if (!project) return;
      const entry = future.at(-1);
      if (!entry) return;
      set({
        project: applyPatches(project, entry.patches),
        past: capPush(past, entry),
        future: future.slice(0, -1),
      });
    },
  };
});

// --- selectors -------------------------------------------------------------------------

/** The zoom segment whose [start,end] contains time `t`, or null. */
export function zoomAt(project: Project | null, t: number): Zoom | null {
  if (!project) return null;
  for (const z of project.zooms) {
    if (t >= z.start && t <= z.end) return z;
  }
  return null;
}

/** Focal of a zoom as a plain {x,y}, resolving the follow default to its declared track. */
export function focalPoint(focal: ZoomFocal): { x: number; y: number } {
  return focal.mode === "fixed" ? { x: focal.x, y: focal.y } : { x: 0.5, y: 0.5 };
}

/** Hook selector: the zoom active at the current playhead. */
export function useActiveZoom(): Zoom | null {
  return useEditor((s) => zoomAt(s.project, s.playhead));
}

/** Hook selector: the currently selected zoom object. */
export function useSelectedZoom(): Zoom | null {
  return useEditor((s) =>
    s.project && s.selectedZoomId
      ? s.project.zooms.find((z) => z.id === s.selectedZoomId) ?? null
      : null,
  );
}
