import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Recording } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schema");

async function loadSchema(name: string): Promise<object> {
  return JSON.parse(await readFile(join(schemaDir, name), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

let validateRecording: (d: unknown) => boolean;

beforeAll(async () => {
  validateRecording = ajv.compile(await loadSchema("recording.schema.json")) as never;
});

// A canonical example, typed against the TS mirror so the two can't drift.
const example: Recording = {
  version: 1,
  id: "rec_abc123",
  title: "Create a project",
  createdAt: "2026-08-08T18:12:04Z",
  startUrl: "https://app.example.com/dashboard",
  viewport: { w: 1440, h: 900 },
  steps: [
    {
      id: "s1",
      t: 0.6,
      action: "click",
      target: {
        primary: { strategy: "testid", value: "new-project-btn", weight: 0.95 },
        fallbacks: [
          { strategy: "text", value: "New Project", weight: 0.7 },
          { strategy: "css", value: "header button.primary", weight: 0.5 },
        ],
      },
      rect: { x: 0.82, y: 0.03, w: 0.12, h: 0.05 },
      caption: "Click New Project",
      liveMode: "auto",
    },
    {
      id: "s2",
      t: 2.1,
      action: "input",
      target: {
        primary: { strategy: "aria", value: "textbox:Project name", weight: 0.9 },
        fallbacks: [{ strategy: "css", value: "#project-name", weight: 0.6 }],
      },
      value: "My first project",
      masked: false,
      rect: { x: 0.35, y: 0.4, w: 0.3, h: 0.04 },
      liveMode: "coach",
      waitFor: { type: "element", value: "#project-name" },
    },
    {
      id: "s3",
      t: 4.0,
      action: "click",
      target: {
        primary: { strategy: "text", value: "Delete", weight: 0.6 },
        fallbacks: [],
      },
      caption: "Delete the draft",
      destructive: true,
    },
  ],
  video: { format: "webm", width: 1440, height: 900, duration: 5.2 },
  cursorPath: {
    origin: "auto",
    mode: "pathClicks",
    keyframes: [
      { t: 0, x: 0.5, y: 0.5 },
      { t: 0.6, x: 0.88, y: 0.055 },
    ],
    clicks: [{ t: 0.65, x: 0.88, y: 0.055, button: "left" }],
  },
};

describe("recording.schema.json", () => {
  it("accepts the canonical example", () => {
    const ok = validateRecording(example);
    if (!ok) console.error(ajv.errorsText((validateRecording as never as { errors: unknown }).errors as never));
    expect(ok).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    expect(validateRecording({ ...example, bogus: 1 })).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(validateRecording({ ...example, version: 2 })).toBe(false);
  });

  it("rejects an unknown step action", () => {
    const bad = structuredClone(example);
    (bad.steps[0] as { action: string }).action = "teleport";
    expect(validateRecording(bad)).toBe(false);
  });

  it("rejects an unknown locator strategy", () => {
    const bad = structuredClone(example);
    bad.steps[0]!.target!.primary.strategy = "psychic" as never;
    expect(validateRecording(bad)).toBe(false);
  });

  it("requires viewport", () => {
    const { viewport: _drop, ...rest } = example;
    expect(validateRecording(rest)).toBe(false);
  });
});
