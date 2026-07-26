import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Project, CursorEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schema");

async function loadSchema(name: string): Promise<object> {
  return JSON.parse(await readFile(join(schemaDir, name), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

let validateProject: (d: unknown) => boolean;
let validateCursor: (d: unknown) => boolean;

beforeAll(async () => {
  validateProject = ajv.compile(await loadSchema("project.schema.json")) as never;
  validateCursor = ajv.compile(await loadSchema("cursor.schema.json")) as never;
});

// The canonical example from BUILD_PLAN §3.3, typed against our TS mirror so the two can't drift.
const exampleProject: Project = {
  version: 1,
  source: {
    master: "master.mov",
    proxy: "proxy.mp4",
    width: 3456,
    height: 2160,
    fps: 60,
    duration: 187.4,
    scale: 2.0,
  },
  audio: [
    { file: "audio-system.m4a", role: "system", gain: 1.0, muted: false },
    { file: "audio-mic.m4a", role: "mic", gain: 1.2, muted: false },
  ],
  trim: { in: 2.15, out: 176.8 },
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
      start: 12.4,
      end: 17.1,
      scale: 2.2,
      focal: { mode: "fixed", x: 0.31, y: 0.62 },
      rampIn: 0.45,
      rampOut: 0.6,
      easing: "cubicInOut",
      origin: "auto",
    },
    {
      id: "z2",
      start: 44.0,
      end: 51.3,
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

const exampleCursor: CursorEvent[] = [
  { t: 0.0, x: 0.4821, y: 0.331, e: "move" },
  { t: 0.512, x: 0.483, y: 0.3312, e: "down", b: "left" },
  { t: 0.598, x: 0.483, y: 0.3312, e: "up", b: "left" },
  { t: 1.204, x: 0.661, y: 0.2044, e: "scroll", dy: -3.0 },
  { t: 2.91, e: "key" },
];

describe("project.schema.json (§3.3)", () => {
  it("accepts the canonical example", () => {
    const ok = validateProject(exampleProject);
    if (!ok) console.error(ajv.errorsText((validateProject as never as { errors: unknown })["errors"] as never));
    expect(ok).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    expect(validateProject({ ...exampleProject, bogus: 1 })).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(validateProject({ ...exampleProject, version: 2 })).toBe(false);
  });

  it("rejects a zoom scale below 1", () => {
    const bad = structuredClone(exampleProject);
    bad.zooms[0]!.scale = 0.5;
    expect(validateProject(bad)).toBe(false);
  });
});

describe("cursor.schema.json (§3.2)", () => {
  it("accepts every example line", () => {
    for (const ev of exampleCursor) expect(validateCursor(ev)).toBe(true);
  });

  it("rejects x out of [0,1]", () => {
    expect(validateCursor({ t: 1, x: 1.4, y: 0.2, e: "move" })).toBe(false);
  });

  it("rejects an unknown event kind", () => {
    expect(validateCursor({ t: 1, e: "teleport" })).toBe(false);
  });

  it("rejects a keycode field (privacy: key events carry no content)", () => {
    expect(validateCursor({ t: 1, e: "key", code: 65 })).toBe(false);
  });
});
