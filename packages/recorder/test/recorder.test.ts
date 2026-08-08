// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mapEventToStep, attach, isSensitive, maskValue } from "../src/index.js";
import type { Step } from "@dolly/schema";

const VP = { w: 1000, h: 800 };

function doc(body: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.body.innerHTML = body;
  return d;
}

function fireOn(el: Element, type: string): Event {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "target", { value: el, enumerable: true });
  return ev;
}

function keyOn(el: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true });
  Object.defineProperty(ev, "target", { value: el, enumerable: true });
  return ev;
}

describe("mapEventToStep", () => {
  it("maps a click to a step with a locator set and rect", () => {
    const d = doc(`<button data-testid="go">Go</button>`);
    const el = d.querySelector("button")!;
    const step = mapEventToStep(fireOn(el, "click"), { t: 1.2, viewport: VP, id: "s1" });
    expect(step).not.toBeNull();
    expect(step!.action).toBe("click");
    expect(step!.target?.primary.strategy).toBe("testid");
    expect(step!.rect).toBeDefined();
    expect(step!.t).toBe(1.2);
  });

  it("captures input value and does not mask a normal field", () => {
    const d = doc(`<input name="title" value="Hello">`);
    const el = d.querySelector("input")!;
    (el as HTMLInputElement).value = "Hello world";
    const step = mapEventToStep(fireOn(el, "input"), { t: 0, viewport: VP, id: "s1" });
    expect(step!.action).toBe("input");
    expect(step!.value).toBe("Hello world");
    expect(step!.masked).toBe(false);
  });

  it("masks a password field's value", () => {
    const d = doc(`<input type="password" name="pw">`);
    const el = d.querySelector("input")!;
    (el as HTMLInputElement).value = "s3cr3t!";
    const step = mapEventToStep(fireOn(el, "input"), { t: 0, viewport: VP, id: "s1" });
    expect(step!.masked).toBe(true);
    expect(step!.value).not.toContain("s3cr3t");
    expect(step!.value).toMatch(/^•+$/);
  });

  it("masks by [data-dolly-secret] opt-out", () => {
    const d = doc(`<div data-dolly-secret><input name="notes" value="x"></div>`);
    const el = d.querySelector("input")!;
    expect(isSensitive(el)).toBe(true);
  });

  it("records navigation keys but not character keys", () => {
    const d = doc(`<input>`);
    const el = d.querySelector("input")!;
    expect(mapEventToStep(keyOn(el, "Enter"), { t: 0, viewport: VP, id: "s1" })?.action).toBe("keypress");
    expect(mapEventToStep(keyOn(el, "a"), { t: 0, viewport: VP, id: "s2" })).toBeNull();
  });

  it("maskValue preserves a bounded length and hides content", () => {
    expect(maskValue("abc")).toBe("•••");
    expect(maskValue("")).toBe("");
    expect(maskValue("x".repeat(100)).length).toBe(24);
  });
});

describe("attach", () => {
  it("streams steps for real dispatched events and detaches cleanly", () => {
    // use the live jsdom document so real events flow through capture-phase listeners
    document.body.innerHTML = `<button id="b">Hit</button><input id="i" name="q">`;
    const steps: Step[] = [];
    let clock = 0;
    const detach = attach(document, (s) => steps.push(s), { now: () => (clock += 10) });

    document.getElementById("b")!.dispatchEvent(new Event("click", { bubbles: true }));
    const input = document.getElementById("i") as HTMLInputElement;
    input.value = "hi";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(steps.length).toBe(2);
    expect(steps[0]!.action).toBe("click");
    expect(steps[1]!.action).toBe("input");
    expect(steps[0]!.id).toBe("s1");
    expect(steps[1]!.id).toBe("s2");

    detach();
    document.getElementById("b")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(steps.length).toBe(2); // no more after detach
  });
});
