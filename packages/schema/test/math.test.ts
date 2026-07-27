import { describe, it, expect } from "vitest";
import {
  focalClamp,
  zoomTransform,
  zoomMatrix,
  applyMat,
  contentRect,
  cubicInOut,
  cubicOut,
  zoomScaleAt,
  springStep,
  OneEuroFilter,
  normDistance,
  catmullRom,
  catmullRomAt,
  type Rect,
  type PathKey,
} from "../src/math.js";

describe("focalClamp (§6.3)", () => {
  it("collapses to center when scale <= 1", () => {
    expect(focalClamp({ x: 0.1, y: 0.9 }, 1)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("keeps the focal at least 1/(2s) from every edge", () => {
    const s = 2;
    const m = 1 / (2 * s); // 0.25
    expect(focalClamp({ x: 0, y: 1 }, s)).toEqual({ x: m, y: 1 - m });
    expect(focalClamp({ x: 0.5, y: 0.5 }, s)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("a corner focal never lets the frame edge move inside the content rect", () => {
    // At the clamped focal, the visible window must still cover [0,1] in source space.
    const content: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const s = 2.4;
    const m = zoomTransform(content, s, { x: 0, y: 0 });
    // Source top-left (0,0) maps to <= content top-left after clamping (covers the corner).
    const p = applyMat(m, content.x, content.y);
    expect(p.x).toBeLessThanOrEqual(content.x + 1e-9);
    expect(p.y).toBeLessThanOrEqual(content.y + 1e-9);
    // Source bottom-right maps to >= content bottom-right.
    const q = applyMat(m, content.x + content.w, content.y + content.h);
    expect(q.x).toBeGreaterThanOrEqual(content.x + content.w - 1e-9);
    expect(q.y).toBeGreaterThanOrEqual(content.y + content.h - 1e-9);
  });
});

describe("zoomMatrix (§6.3)", () => {
  it("at scale 1 with center focal is the identity over the content rect", () => {
    const content: Rect = { x: 10, y: 20, w: 100, h: 80 };
    const m = zoomMatrix(content, 1, { x: 0.5, y: 0.5 });
    const p = applyMat(m, 60, 60);
    expect(p.x).toBeCloseTo(60, 9);
    expect(p.y).toBeCloseTo(60, 9);
  });

  it("holds the focal point fixed under scaling", () => {
    const content: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const focal = { x: 0.3, y: 0.7 };
    const m = zoomMatrix(content, 2, focal);
    const focalPx = { x: content.x + focal.x * content.w, y: content.y + focal.y * content.h };
    const mapped = applyMat(m, focalPx.x, focalPx.y);
    // The focal pixel maps to the center of the content rect.
    expect(mapped.x).toBeCloseTo(content.x + content.w / 2, 9);
    expect(mapped.y).toBeCloseTo(content.y + content.h / 2, 9);
  });
});

describe("contentRect (§6.3)", () => {
  it("insets by padding*min(W,H) and aspect-fits", () => {
    const r = contentRect(1600, 900, 16 / 9, 0.06);
    const inset = 0.06 * 900; // 54
    // 16:9 source into the wider inset box (aspect ~1.88) is height-limited:
    // it fills the box height and centers horizontally.
    expect(r.y).toBeCloseTo(inset, 6);
    expect(r.h).toBeCloseTo(900 - 2 * inset, 6);
    expect(r.x).toBeGreaterThan(inset); // centered, so left of content > inset
    expect(r.w / r.h).toBeCloseTo(16 / 9, 6);
  });

  it("stays inside the canvas", () => {
    const r = contentRect(1000, 1000, 21 / 9, 0.1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1000 + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(1000 + 1e-6);
  });
});

describe("easings", () => {
  it("cubicInOut hits the endpoints and midpoint", () => {
    expect(cubicInOut(0)).toBeCloseTo(0, 9);
    expect(cubicInOut(1)).toBeCloseTo(1, 9);
    expect(cubicInOut(0.5)).toBeCloseTo(0.5, 9);
  });
  it("cubicOut is monotone and hits endpoints", () => {
    expect(cubicOut(0)).toBeCloseTo(0, 9);
    expect(cubicOut(1)).toBeCloseTo(1, 9);
    expect(cubicOut(0.5)).toBeGreaterThan(0.5); // eases out fast
  });
});

describe("zoomScaleAt (§6.3 ramps)", () => {
  const z = { start: 10, end: 20, scale: 2, rampIn: 1, rampOut: 2, easing: "cubicInOut" as const };
  it("is 1 outside the segment", () => {
    expect(zoomScaleAt(z, 9)).toBe(1);
    expect(zoomScaleAt(z, 21)).toBe(1);
  });
  it("reaches full scale on the hold", () => {
    expect(zoomScaleAt(z, 15)).toBeCloseTo(2, 9);
  });
  it("ramps up from 1 and down to 1", () => {
    expect(zoomScaleAt(z, 10.0001)).toBeGreaterThan(1);
    expect(zoomScaleAt(z, 10.5)).toBeLessThan(2);
    expect(zoomScaleAt(z, 19.5)).toBeLessThan(2);
    expect(zoomScaleAt(z, 19.9999)).toBeGreaterThan(1);
  });
});

describe("springStep (§6.3)", () => {
  it("converges monotonically to the target without overshoot", () => {
    let s = { pos: 0, vel: 0 };
    const target = 1;
    const dt = 1 / 60;
    let maxPos = 0;
    for (let i = 0; i < 600; i++) {
      s = springStep(s, target, 0.2, dt);
      maxPos = Math.max(maxPos, s.pos);
    }
    expect(s.pos).toBeCloseTo(1, 2);
    // critically damped => no meaningful overshoot beyond the target
    expect(maxPos).toBeLessThanOrEqual(1.02);
  });
});

describe("OneEuroFilter (§6.4)", () => {
  it("passes the first sample through", () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.5, 0)).toBe(0.5);
  });
  it("attenuates high-frequency jitter around a constant signal", () => {
    const clean = new OneEuroFilter(1.0, 0.02);
    let sumErr = 0;
    const n = 200;
    for (let i = 1; i <= n; i++) {
      const t = i / 60;
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.05;
      const out = clean.filter(0.5 + jitter, t);
      sumErr += Math.abs(out - 0.5);
    }
    // Mean residual jitter should be far below the injected 0.05 amplitude.
    expect(sumErr / n).toBeLessThan(0.02);
  });
  it("is deterministic", () => {
    const run = () => {
      const f = new OneEuroFilter();
      const out: number[] = [];
      for (let i = 0; i < 50; i++) out.push(f.filter(Math.sin(i / 5), i / 60));
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("normDistance", () => {
  it("is 1 across the full diagonal", () => {
    expect(normDistance(0, 0, 1, 1)).toBeCloseTo(1, 9);
  });
});

describe("catmullRom / catmullRomAt (Cursorcraft)", () => {
  it("passes through the endpoints of a segment", () => {
    // at u=0 -> p1, at u=1 -> p2
    expect(catmullRom(0, 0.2, 0.8, 1, 0)).toBeCloseTo(0.2, 9);
    expect(catmullRom(0, 0.2, 0.8, 1, 1)).toBeCloseTo(0.8, 9);
  });

  it("reproduces a straight line exactly (collinear controls)", () => {
    // control values on the line f(u)=u should interpolate linearly
    expect(catmullRom(-1, 0, 1, 2, 0.5)).toBeCloseTo(0.5, 9);
    expect(catmullRom(-1, 0, 1, 2, 0.25)).toBeCloseTo(0.25, 9);
  });

  const keys: PathKey[] = [
    { t: 0, x: 0.1, y: 0.1 },
    { t: 1, x: 0.4, y: 0.2 },
    { t: 2, x: 0.6, y: 0.7 },
    { t: 3, x: 0.9, y: 0.8 },
  ];

  it("passes through every keyframe at its timestamp", () => {
    for (const k of keys) {
      const p = catmullRomAt(keys, k.t);
      expect(p.x).toBeCloseTo(k.x, 9);
      expect(p.y).toBeCloseTo(k.y, 9);
    }
  });

  it("clamps before the first and after the last keyframe", () => {
    expect(catmullRomAt(keys, -5)).toEqual({ x: 0.1, y: 0.1 });
    expect(catmullRomAt(keys, 99)).toEqual({ x: 0.9, y: 0.8 });
  });

  it("stays within the convex hull for a monotone path (no wild overshoot)", () => {
    for (let t = 0; t <= 3; t += 0.05) {
      const p = catmullRomAt(keys, t);
      expect(p.x).toBeGreaterThanOrEqual(0.05);
      expect(p.x).toBeLessThanOrEqual(0.95);
      expect(p.y).toBeGreaterThanOrEqual(0.05);
      expect(p.y).toBeLessThanOrEqual(0.85);
    }
  });

  it("handles empty and single-point paths", () => {
    expect(catmullRomAt([], 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(catmullRomAt([{ t: 0, x: 0.3, y: 0.7 }], 5)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("is deterministic", () => {
    const a = Array.from({ length: 20 }, (_, i) => catmullRomAt(keys, i * 0.15));
    const b = Array.from({ length: 20 }, (_, i) => catmullRomAt(keys, i * 0.15));
    expect(a).toEqual(b);
  });
});
