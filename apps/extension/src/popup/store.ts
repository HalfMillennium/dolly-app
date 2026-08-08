/**
 * Popup step-editor store (salvaged zustand + structural-clone undo/redo from the old desktop
 * editor). Holds the working step list; the author can retitle, caption, delete/reorder steps,
 * and set each step's live-replay mode before exporting a Recording.
 */
import { create } from "zustand";
import type { LiveMode, Recording, Step } from "@dolly/schema";

const HISTORY_CAP = 50;

export interface EditorState {
  title: string;
  startUrl: string;
  viewport: { w: number; h: number };
  steps: Step[];
  liveDefault: "auto" | "coach";
  selected: string | null;
  past: Step[][];
  future: Step[][];

  load: (rec: { title?: string; startUrl: string; viewport: { w: number; h: number }; steps: Step[] }) => void;
  setTitle: (title: string) => void;
  setLiveDefault: (m: "auto" | "coach") => void;
  select: (id: string | null) => void;
  setCaption: (id: string, caption: string) => void;
  setLiveMode: (id: string, mode: LiveMode) => void;
  toggleDestructive: (id: string) => void;
  remove: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  undo: () => void;
  redo: () => void;
  toRecording: () => Recording;
}

function commit(state: EditorState, next: Step[]): Partial<EditorState> {
  const past = [...state.past, state.steps].slice(-HISTORY_CAP);
  return { steps: next, past, future: [] };
}

export const useEditor = create<EditorState>((set, get) => ({
  title: "Untitled walkthrough",
  startUrl: "",
  viewport: { w: 1280, h: 800 },
  steps: [],
  liveDefault: "coach",
  selected: null,
  past: [],
  future: [],

  load: (rec) =>
    set({
      title: rec.title ?? "Untitled walkthrough",
      startUrl: rec.startUrl,
      viewport: rec.viewport,
      steps: rec.steps,
      past: [],
      future: [],
      selected: rec.steps[0]?.id ?? null,
    }),

  setTitle: (title) => set({ title }),
  setLiveDefault: (liveDefault) => set({ liveDefault }),
  select: (selected) => set({ selected }),

  setCaption: (id, caption) =>
    set((s) => commit(s, s.steps.map((st) => (st.id === id ? { ...st, caption } : st)))),

  setLiveMode: (id, mode) =>
    set((s) => commit(s, s.steps.map((st) => (st.id === id ? { ...st, liveMode: mode } : st)))),

  toggleDestructive: (id) =>
    set((s) =>
      commit(s, s.steps.map((st) => (st.id === id ? { ...st, destructive: !st.destructive } : st))),
    ),

  remove: (id) => set((s) => commit(s, s.steps.filter((st) => st.id !== id))),

  move: (id, dir) =>
    set((s) => {
      const i = s.steps.findIndex((st) => st.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.steps.length) return {};
      const next = s.steps.slice();
      const a = next[i]!;
      const b = next[j]!;
      next[i] = b;
      next[j] = a;
      return commit(s, next);
    }),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return { steps: prev, past: s.past.slice(0, -1), future: [s.steps, ...s.future].slice(0, HISTORY_CAP) };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return { steps: next, future: s.future.slice(1), past: [...s.past, s.steps].slice(-HISTORY_CAP) };
    }),

  toRecording: () => {
    const s = get();
    return {
      version: 1,
      id: `rec_${s.startUrl.replace(/\W+/g, "").slice(0, 12)}_${s.steps.length}`,
      title: s.title,
      createdAt: new Date().toISOString(),
      startUrl: s.startUrl,
      viewport: s.viewport,
      steps: s.steps,
    } satisfies Recording;
  },
}));
