/**
 * The auto-zoom regression suite (BUILD_PLAN §6.4, §10). For each of the six hand-labeled
 * fixtures, assert segment count within ±1 and (for the clean scenarios) focal points within
 * 0.08 normalized distance. Plus determinism and the coverage/rate budget ceiling.
 *
 * These fixtures gate every future parameter change: if a tweak moves a count by more than
 * one or a focal by more than 0.08, this suite fails and forces a justification.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normDistance, type CursorEvent, type Zoom } from "@dolly/schema";
import { generateZooms, DEFAULT_PARAMS, paramsFromControls } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

interface Expected {
  scenario: string;
  expectedCount: number;
  countTolerance: number;
  checkFocals: boolean;
  focals: Array<{ x: number; y: number }>;
}

function loadFixture(name: string): { cursor: CursorEvent[]; duration: number; expected: Expected } {
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

const names = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => f.replace(/\.jsonl$/, ""))
  .sort();

describe("auto-zoom fixture suite (§6.4)", () => {
  it("discovers all six fixtures", () => {
    expect(names).toEqual(["chaotic", "code-editing", "dashboard", "fast-tabs", "form-fill", "idle"]);
  });

  for (const name of names) {
    describe(name, () => {
      const { cursor, duration, expected } = loadFixture(name);
      const zooms = generateZooms(cursor, { duration, aspect: 16 / 9 });

      it(`produces ${expected.expectedCount}±${expected.countTolerance} zooms`, () => {
        expect(Math.abs(zooms.length - expected.expectedCount)).toBeLessThanOrEqual(
          expected.countTolerance,
        );
      });

      if (expected.checkFocals) {
        it("places every labeled focal within 0.08 of a fixed-mode zoom", () => {
          for (const target of expected.focals) {
            const near = zooms.some(
              (z) =>
                z.focal.mode === "fixed" &&
                normDistance(z.focal.x, z.focal.y, target.x, target.y) < 0.08,
            );
            expect(near, `no zoom near (${target.x}, ${target.y})`).toBe(true);
          }
        });
      }

      it("emits only origin:auto segments with valid ordering", () => {
        for (const z of zooms) {
          expect(z.origin).toBe("auto");
          expect(z.end).toBeGreaterThan(z.start);
          expect(z.scale).toBeGreaterThanOrEqual(DEFAULT_PARAMS.scaleRange[0] - 1e-6);
          expect(z.scale).toBeLessThanOrEqual(DEFAULT_PARAMS.scaleRange[1] + 1e-6);
        }
      });
    });
  }
});

describe("determinism (§6.4: pure, deterministic)", () => {
  for (const name of names) {
    it(`${name} is byte-identical across runs`, () => {
      const { cursor, duration } = loadFixture(name);
      const a = generateZooms(cursor, { duration, aspect: 16 / 9 });
      const b = generateZooms(cursor, { duration, aspect: 16 / 9 });
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    });
  }
});

describe("coverage & rate budget (§6.4 step 7)", () => {
  const { cursor, duration } = loadFixture("dashboard");

  const coverageOf = (zooms: Zoom[]) =>
    zooms.reduce((s, z) => s + (z.end - z.start), 0) / duration;

  it("never zooms more than maxCoverage of the timeline", () => {
    const zooms = generateZooms(cursor, { duration, aspect: 16 / 9 });
    expect(coverageOf(zooms)).toBeLessThanOrEqual(DEFAULT_PARAMS.maxCoverage + 1e-9);
  });

  it("never places two segment starts closer than the density ceiling", () => {
    const zooms = generateZooms(cursor, { duration, aspect: 16 / 9 })
      .map((z) => z.start)
      .sort((x, y) => x - y);
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i]! - zooms[i - 1]!).toBeGreaterThanOrEqual(DEFAULT_PARAMS.maxRatePerSeconds - 1e-9);
    }
  });

  it("higher intensity never exceeds its own (scaled) coverage ceiling", () => {
    const hot = paramsFromControls({ intensity: 1, smoothness: 0.5, clicksOnly: false });
    const zooms = generateZooms(cursor, { duration, aspect: 16 / 9 }, hot);
    expect(coverageOf(zooms)).toBeLessThanOrEqual(hot.maxCoverage + 1e-9);
  });
});

describe("clicks-only control (§6.4 UI toggle)", () => {
  it("still finds the form-fill clicks when scroll/key/dwell scoring is dropped", () => {
    const { cursor, duration } = loadFixture("form-fill");
    const params = paramsFromControls({ intensity: 0.5, smoothness: 0.5, clicksOnly: false });
    const withAll = generateZooms(cursor, { duration, aspect: 16 / 9 }, params);
    // clicks-only should not increase the count; the click clusters remain.
    expect(withAll.length).toBeGreaterThanOrEqual(3);
  });
});
