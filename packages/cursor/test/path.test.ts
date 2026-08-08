// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildTutorialPath } from "../src/index.js";
import { catmullRomAt, normDistance, type Step } from "@dolly/schema";

const VP = { w: 1440, h: 900 };

function step(id: string, t: number, cx: number, cy: number, action: Step["action"]): Step {
  return { id, t, action, rect: { x: cx - 0.01, y: cy - 0.01, w: 0.02, h: 0.02 } };
}

describe("buildTutorialPath", () => {
  const steps: Step[] = [
    step("s1", 0.5, 0.2, 0.2, "click"),
    step("s2", 2.0, 0.8, 0.3, "click"),
    step("s3", 3.5, 0.5, 0.8, "input"),
  ];
  const path = buildTutorialPath(steps, { viewport: VP });

  it("produces a non-empty, time-ordered keyframe path", () => {
    expect(path.keyframes.length).toBeGreaterThan(0);
    for (let i = 1; i < path.keyframes.length; i++) {
      expect(path.keyframes[i]!.t).toBeGreaterThan(path.keyframes[i - 1]!.t);
    }
  });

  it("passes near each step's target center", () => {
    for (const s of steps) {
      const cx = s.rect!.x + s.rect!.w / 2;
      const cy = s.rect!.y + s.rect!.h / 2;
      const hit = path.keyframes.some((k) => normDistance(k.x, k.y, cx, cy) < 0.12);
      expect(hit, `no keyframe near (${cx},${cy})`).toBe(true);
    }
  });

  it("emits a click mark for each click/submit step", () => {
    expect(path.clicks.length).toBeGreaterThanOrEqual(2);
  });

  it("is evaluable with the shared spline at any time", () => {
    const p = catmullRomAt(path.keyframes, 2.0);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
  });

  it("returns an empty path when no step has a rect", () => {
    const empty = buildTutorialPath([{ id: "n", t: 0, action: "navigate", url: "x" }], { viewport: VP });
    expect(empty.keyframes).toEqual([]);
  });
});
