/**
 * Deterministically synthesize the six auto-zoom regression fixtures (BUILD_PLAN §6.4).
 *
 * These are SYNTHETIC traces, not real recordings — this repo is built headless, so there is
 * no capture hardware to record from. Each scenario is hand-designed to exercise a distinct
 * regime (clustered clicks, chaotic motion, idleness, ...); the committed `.expected.json`
 * files hand-label the intended behavior. When real recordings become available on macOS,
 * drop them in alongside these and delete the synthetic ones.
 *
 * Run with `pnpm --filter @dolly/autozoom make-fixtures`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CursorEvent } from "@dolly/schema";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures");

/** mulberry32: tiny deterministic PRNG so fixtures never depend on Math.random. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Trace {
  events: CursorEvent[] = [];
  t = 0;
  x = 0.5;
  y = 0.5;
  constructor(private jitter: () => number) {}

  wait(dt: number) {
    this.t += dt;
  }

  /** move to (x,y) over `dur` seconds, emitting throttled samples with slight jitter */
  moveTo(x: number, y: number, dur: number) {
    const steps = Math.max(1, Math.round(dur * 60));
    const sx = this.x;
    const sy = this.y;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      this.t += dur / steps;
      const jx = (this.jitter() - 0.5) * 0.004;
      const jy = (this.jitter() - 0.5) * 0.004;
      this.x = clamp01(sx + (x - sx) * f + jx);
      this.y = clamp01(sy + (y - sy) * f + jy);
      this.events.push({ t: r(this.t), x: r(this.x), y: r(this.y), e: "move" });
    }
    this.x = clamp01(x);
    this.y = clamp01(y);
  }

  click() {
    this.events.push({ t: r(this.t), x: r(this.x), y: r(this.y), e: "down", b: "left" });
    this.t += 0.08;
    this.events.push({ t: r(this.t), x: r(this.x), y: r(this.y), e: "up", b: "left" });
  }

  /** simulate typing for `dur` seconds: key events at a human rhythm */
  type(dur: number) {
    const end = this.t + dur;
    while (this.t < end) {
      this.t += 0.08 + this.jitter() * 0.12;
      this.events.push({ t: r(this.t), e: "key" });
    }
  }

  scroll(count: number, dy: number) {
    for (let i = 0; i < count; i++) {
      this.t += 0.05 + this.jitter() * 0.05;
      this.events.push({ t: r(this.t), x: r(this.x), y: r(this.y), e: "scroll", dy });
    }
  }

  /** dwell in place (small idle) for `dur` seconds with no discrete events */
  dwell(dur: number) {
    const steps = Math.max(1, Math.round(dur * 30));
    for (let i = 0; i < steps; i++) {
      this.t += dur / steps;
      const jx = (this.jitter() - 0.5) * 0.002;
      const jy = (this.jitter() - 0.5) * 0.002;
      this.events.push({ t: r(this.t), x: r(this.x + jx), y: r(this.y + jy), e: "move" });
    }
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function r(v: number) {
  return Math.round(v * 1e4) / 1e4;
}

// --- scenario 1: form fill — clicks down a column, typing between them ------------------
function formFill(): CursorEvent[] {
  const tr = new Trace(rng(101));
  const fields: Array<[number, number]> = [
    [0.44, 0.3],
    [0.46, 0.45],
    [0.45, 0.6],
  ];
  tr.moveTo(0.44, 0.3, 1.0);
  for (const [x, y] of fields) {
    tr.moveTo(x, y, 0.5);
    tr.click();
    tr.dwell(0.3);
    tr.type(3.5);
    tr.wait(0.4);
  }
  tr.moveTo(0.62, 0.72, 0.6); // submit button
  tr.click();
  tr.dwell(1.0);
  return tr.events;
}

// --- scenario 2: code editing — typing bursts + scrolls in a left-side editor ----------
function codeEditing(): CursorEvent[] {
  const tr = new Trace(rng(202));
  tr.moveTo(0.28, 0.4, 1.0);
  tr.click();
  tr.type(6.0);
  tr.scroll(6, -3);
  tr.type(5.0);
  tr.moveTo(0.3, 0.55, 0.4);
  tr.click();
  tr.type(4.5);
  tr.scroll(4, -3);
  tr.dwell(1.0);
  return tr.events;
}

// --- scenario 3: dashboard walkthrough — clicks + dwells at distinct widgets -----------
function dashboard(): CursorEvent[] {
  const tr = new Trace(rng(303));
  const widgets: Array<[number, number]> = [
    [0.2, 0.25],
    [0.75, 0.28],
    [0.72, 0.7],
    [0.25, 0.72],
  ];
  // A walkthrough is deliberately paced: the presenter clicks a widget, then talks about it
  // for a few seconds before moving on. That >4s cadence keeps every widget under the
  // density ceiling (§6.4 maxRate), so each becomes its own zoom.
  tr.moveTo(0.2, 0.25, 1.2);
  for (const [x, y] of widgets) {
    tr.moveTo(x, y, 1.0);
    tr.click();
    tr.dwell(2.8);
    tr.wait(0.6);
  }
  return tr.events;
}

// --- scenario 4: fast tab-switching — rapid far-apart clicks in a short window ---------
function fastTabs(): CursorEvent[] {
  const tr = new Trace(rng(404));
  const spots: Array<[number, number]> = [
    [0.1, 0.05],
    [0.3, 0.05],
    [0.5, 0.05],
    [0.7, 0.05],
    [0.2, 0.05],
    [0.6, 0.05],
  ];
  for (const [x, y] of spots) {
    tr.moveTo(x, y, 0.35);
    tr.click();
    tr.dwell(0.5);
  }
  tr.dwell(2.0);
  return tr.events;
}

// --- scenario 5: idle — almost nothing happens ----------------------------------------
function idle(): CursorEvent[] {
  const tr = new Trace(rng(505));
  tr.dwell(20.0);
  tr.moveTo(0.52, 0.5, 0.5);
  tr.dwell(10.0);
  return tr.events;
}

// --- scenario 6: chaotic mouse-waving — continuous large motion, no clicks -------------
function chaotic(): CursorEvent[] {
  const tr = new Trace(rng(606));
  const jr = rng(6061);
  for (let i = 0; i < 40; i++) {
    tr.moveTo(jr(), jr(), 0.4 + jr() * 0.3);
  }
  return tr.events;
}

const scenarios: Record<string, () => CursorEvent[]> = {
  "form-fill": formFill,
  "code-editing": codeEditing,
  "dashboard": dashboard,
  "fast-tabs": fastTabs,
  "idle": idle,
  "chaotic": chaotic,
};

await mkdir(outDir, { recursive: true });
for (const [name, gen] of Object.entries(scenarios)) {
  const events = gen();
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(outDir, `${name}.jsonl`), jsonl, "utf8");
  const dur = events.length ? events[events.length - 1]!.t : 0;
  // eslint-disable-next-line no-console
  console.log(`${name}: ${events.length} events, ${dur.toFixed(1)}s`);
}
