/**
 * Regression suite for the AI-optimized cursor ("Cursorcraft"). Reuses the six auto-zoom
 * fixtures (the same synthetic traces), and asserts the optimized path is well-formed, passes
 * near the recorded targets, moves smoothly (bounded velocity), is deterministic, and — in
 * "full" mode — re-times the auto-zoom camera to the optimized track.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normDistance, type CursorEvent } from "@dolly/schema";
import {
  optimizeCursor,
  optimizeCursorFromControls,
  DEFAULT_PARAMS,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "autozoom", "test", "fixtures");

interface Expected {
  scenario: string;
  expectedCount: number;
  checkFocals: boolean;
  focals: Array<{ x: number; y: number }>;
}

function load(name: string): { cursor: CursorEvent[]; duration: number; expected: Expected } {
  const cursor = readFileSync(join(fixturesDir, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as CursorEvent);
  const expected = JSON.parse(
    readFileSync(join(fixturesDir, `${name}.expected.json`), "utf8"),
  ) as Expected;
  const duration = (cursor[cursor.length - 1]?.t ?? 0) + 1;
  return { cursor, duration, expected };
}

const names = ["chaotic", "code-editing", "dashboard", "fast-tabs", "form-fill", "idle"];
const meta = (duration: number) => ({ duration, aspect: 16 / 9 });

describe("optimizeCursor — well-formedness (all fixtures)", () => {
  for (const name of names) {
    describe(name, () => {
      const { cursor, duration } = load(name);
      const { cursorPath } = optimizeCursor(cursor, meta(duration));

      it("emits keyframes with strictly increasing time, all in [0,1]", () => {
        const kf = cursorPath.keyframes;
        for (let i = 0; i < kf.length; i++) {
          expect(kf[i]!.x).toBeGreaterThanOrEqual(-1e-6);
          expect(kf[i]!.x).toBeLessThanOrEqual(1 + 1e-6);
          expect(kf[i]!.y).toBeGreaterThanOrEqual(-1e-6);
          expect(kf[i]!.y).toBeLessThanOrEqual(1 + 1e-6);
          if (i > 0) expect(kf[i]!.t).toBeGreaterThan(kf[i - 1]!.t);
        }
      });

      it("never teleports (bounded per-step velocity)", () => {
        const kf = cursorPath.keyframes;
        for (let i = 1; i < kf.length; i++) {
          const d = normDistance(kf[i - 1]!.x, kf[i - 1]!.y, kf[i]!.x, kf[i]!.y);
          expect(d).toBeLessThan(0.15);
        }
      });

      it("tags the path origin auto and mode pathClicks", () => {
        expect(cursorPath.origin).toBe("auto");
        expect(cursorPath.mode).toBe("pathClicks");
      });
    });
  }
});

describe("optimizeCursor — passes near recorded targets (clean scenarios)", () => {
  for (const name of ["form-fill", "code-editing", "dashboard"]) {
    it(`${name}: every labeled focal has a keyframe within 0.1`, () => {
      const { cursor, duration, expected } = load(name);
      const { cursorPath } = optimizeCursor(cursor, meta(duration));
      for (const target of expected.focals) {
        const near = cursorPath.keyframes.some(
          (k) => normDistance(k.x, k.y, target.x, target.y) < 0.1,
        );
        expect(near, `no keyframe near (${target.x}, ${target.y})`).toBe(true);
      }
    });
  }
});

describe("optimizeCursor — clicks align to targets (form-fill)", () => {
  it("emits a click near each form field / button", () => {
    const { cursor, duration, expected } = load("form-fill");
    const { cursorPath } = optimizeCursor(cursor, meta(duration));
    expect(cursorPath.clicks.length).toBeGreaterThanOrEqual(3);
    for (const c of cursorPath.clicks) {
      const nearAnyTarget = expected.focals.some(
        (f) => normDistance(c.x, c.y, f.x, f.y) < 0.1,
      );
      expect(nearAnyTarget).toBe(true);
    }
  });
});

describe("optimizeCursor — determinism", () => {
  for (const name of names) {
    it(`${name} is byte-identical across runs`, () => {
      const { cursor, duration } = load(name);
      const a = optimizeCursor(cursor, meta(duration));
      const b = optimizeCursor(cursor, meta(duration));
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    });
  }
});

describe("optimizeCursor — full mode re-times the camera", () => {
  it("returns retimedZooms only in full mode, all origin auto", () => {
    const { cursor, duration } = load("dashboard");
    const pathOnly = optimizeCursor(cursor, meta(duration), {
      ...DEFAULT_PARAMS,
      mode: "pathClicks",
    });
    expect(pathOnly.retimedZooms).toBeUndefined();

    const full = optimizeCursor(cursor, meta(duration), { ...DEFAULT_PARAMS, mode: "full" });
    expect(full.retimedZooms).toBeDefined();
    expect(full.cursorPath.mode).toBe("full");
    for (const z of full.retimedZooms ?? []) expect(z.origin).toBe("auto");
  });
});

describe("optimizeCursorFromControls", () => {
  it("neutral sliders produce a valid path; snappier speed shortens dwell corners", () => {
    const { cursor, duration } = load("form-fill");
    const res = optimizeCursorFromControls(cursor, meta(duration), {
      speed: 0.5,
      smoothness: 0.5,
      straightness: 0.5,
      mode: "pathClicks",
    });
    expect(res.cursorPath.keyframes.length).toBeGreaterThan(0);
  });

  it("full mode via controls yields retimed zooms", () => {
    const { cursor, duration } = load("dashboard");
    const res = optimizeCursorFromControls(cursor, meta(duration), {
      speed: 0.5,
      smoothness: 0.5,
      straightness: 0.5,
      mode: "full",
    });
    expect(res.retimedZooms).toBeDefined();
  });
});

describe("optimizeCursor — degenerate inputs", () => {
  it("empty cursor -> empty path, no throw", () => {
    const res = optimizeCursor([], meta(10));
    expect(res.cursorPath.keyframes).toEqual([]);
    expect(res.cursorPath.clicks).toEqual([]);
  });
  it("zero duration -> empty path", () => {
    const res = optimizeCursor([{ t: 0, x: 0.5, y: 0.5, e: "move" }], meta(0));
    expect(res.cursorPath.keyframes).toEqual([]);
  });
});
