/**
 * A synthetic in-memory project + cursor track so the editor is populated without a real
 * recording (there is no `.dolly` bundle on this host). Values mirror the BUILD_PLAN §3.3
 * example shape. In the shipped app these come from opening a project bundle.
 */
import type { CursorEvent, Project } from "@dolly/schema";

export const DEMO_DURATION = 60;

export const demoProject: Project = {
  version: 1,
  source: {
    master: "master.mov",
    proxy: "proxy.mp4",
    width: 2560,
    height: 1600,
    fps: 60,
    duration: DEMO_DURATION,
    scale: 2.0,
  },
  audio: [
    { file: "audio-system.m4a", role: "system", gain: 1.0, muted: false },
    { file: "audio-mic.m4a", role: "mic", gain: 1.2, muted: false },
  ],
  trim: { in: 0, out: DEMO_DURATION },
  composition: {
    backdrop: { type: "gradient", from: "#2A3138", to: "#151A1F", angle: 135 },
    padding: 0.06,
    radius: 12,
    shadow: { enabled: true, opacity: 0.45, blur: 48, y: 14 },
  },
  cursor: { visible: true, size: 1.0, smoothing: 0.35, clickRipple: true, hideWhenIdle: 2.0 },
  zooms: [
    {
      id: "z1",
      start: 6.4,
      end: 12.1,
      scale: 2.2,
      focal: { mode: "fixed", x: 0.31, y: 0.62 },
      rampIn: 0.45,
      rampOut: 0.6,
      easing: "cubicInOut",
      origin: "auto",
    },
    {
      id: "m1",
      start: 20.0,
      end: 27.3,
      scale: 1.8,
      focal: { mode: "follow", damping: 0.12, track: "cursor" },
      rampIn: 0.45,
      rampOut: 0.6,
      easing: "cubicInOut",
      origin: "manual",
    },
  ],
  speed: [],
  autoZoom: { lastRunParams: {}, generatedAt: "2026-07-26T18:12:04Z" },
};

/** A small synthetic cursor track: a couple of dwell/click clusters and some drift. */
export function demoCursor(): CursorEvent[] {
  const events: CursorEvent[] = [];
  // cluster A around (0.31, 0.62) with a click
  for (let t = 6.5; t < 11.5; t += 0.1) {
    events.push({ t, x: 0.31 + Math.sin(t) * 0.01, y: 0.62 + Math.cos(t) * 0.01, e: "move" });
  }
  events.push({ t: 7.0, x: 0.31, y: 0.62, e: "down", b: "left" });
  events.push({ t: 7.08, x: 0.31, y: 0.62, e: "up", b: "left" });
  events.push({ t: 9.4, x: 0.315, y: 0.61, e: "down", b: "left" });
  events.push({ t: 9.48, x: 0.315, y: 0.61, e: "up", b: "left" });
  // travel
  for (let t = 12.0; t < 20.0; t += 0.2) {
    const f = (t - 12) / 8;
    events.push({ t, x: 0.31 + f * 0.4, y: 0.62 - f * 0.3, e: "move" });
  }
  // cluster B, wandering (follow-worthy spread) around (0.7, 0.32)
  for (let t = 20.0; t < 27.0; t += 0.12) {
    events.push({ t, x: 0.7 + Math.sin(t * 1.7) * 0.09, y: 0.32 + Math.cos(t * 1.3) * 0.07, e: "drag", b: "left" });
  }
  events.push({ t: 22.5, x: 0.72, y: 0.31, e: "scroll", dy: -3 });
  return events.sort((a, b) => a.t - b.t);
}
