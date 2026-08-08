// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { effectiveMode, expectedEventType, resolveStep, dispatchAction } from "../src/driver.js";
import { describe as locate } from "@dolly/selector";
import type { Step } from "@dolly/schema";

function doc(body: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.body.innerHTML = body;
  return d;
}
function clickStep(d: Document, sel: string, extra: Partial<Step> = {}): Step {
  const el = d.querySelector(sel)!;
  return { id: "s", t: 0, action: "click", target: locate(el, d), ...extra };
}

describe("effectiveMode", () => {
  const base: Step = { id: "s", t: 0, action: "click" };
  it("coaches destructive steps regardless of default", () => {
    expect(effectiveMode({ ...base, destructive: true }, "auto")).toBe("coach");
  });
  it("honors an explicit step mode", () => {
    expect(effectiveMode({ ...base, liveMode: "coach" }, "auto")).toBe("coach");
    expect(effectiveMode({ ...base, liveMode: "auto" }, "coach")).toBe("auto");
  });
  it("falls back to the default for inherit/unset", () => {
    expect(effectiveMode({ ...base, liveMode: "inherit" }, "coach")).toBe("coach");
    expect(effectiveMode(base, "auto")).toBe("auto");
  });
});

describe("expectedEventType", () => {
  it("maps actions to completion events", () => {
    expect(expectedEventType("click")).toBe("click");
    expect(expectedEventType("input")).toBe("input");
    expect(expectedEventType("keypress")).toBe("keydown");
    expect(expectedEventType("navigate")).toBeNull();
  });
});

describe("resolveStep (self-healing)", () => {
  it("resolves the target after id churn", () => {
    const rec = doc(`<button id="go-1">Continue</button>`);
    const step = clickStep(rec, "#go-1");
    const drift = doc(`<button id="go-999" data-truth="1">Continue</button>`);
    const res = resolveStep(step, drift);
    expect(res.status).toBe("ready");
    expect(res.el?.getAttribute("data-truth")).toBe("1");
  });
  it("reports notfound when the element is gone", () => {
    const rec = doc(`<button data-testid="x">Do it</button>`);
    const step = clickStep(rec, "button");
    expect(resolveStep(step, doc(`<p>nope</p>`)).status).toBe("notfound");
  });
  it("reports notarget for a navigate step", () => {
    expect(resolveStep({ id: "s", t: 0, action: "navigate", url: "/x" }, document).status).toBe("notarget");
  });
});

describe("dispatchAction (auto-run)", () => {
  it("clicks the element", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    let clicked = false;
    document.getElementById("b")!.addEventListener("click", () => (clicked = true));
    const step: Step = { id: "s", t: 0, action: "click" };
    expect(dispatchAction(step, document.getElementById("b"))).toEqual({ kind: "done" });
    expect(clicked).toBe(true);
  });

  it("fills an input and fires input/change", () => {
    document.body.innerHTML = `<input id="i">`;
    const input = document.getElementById("i") as HTMLInputElement;
    let fired = 0;
    input.addEventListener("input", () => fired++);
    input.addEventListener("change", () => fired++);
    const step: Step = { id: "s", t: 0, action: "input", value: "hello" };
    expect(dispatchAction(step, input)).toEqual({ kind: "done" });
    expect(input.value).toBe("hello");
    expect(fired).toBe(2);
  });

  it("pauses for user input on a masked field", () => {
    document.body.innerHTML = `<input id="p" type="password">`;
    const step: Step = { id: "s", t: 0, action: "input", value: "••••", masked: true };
    expect(dispatchAction(step, document.getElementById("p"))).toEqual({ kind: "needsInput" });
  });

  it("submits the enclosing form", () => {
    document.body.innerHTML = `<form id="f"><button id="s">Save</button></form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    let submitted = false;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    const step: Step = { id: "s", t: 0, action: "submit" };
    dispatchAction(step, document.getElementById("s"));
    expect(submitted).toBe(true);
  });

  it("returns a navigate outcome for navigate steps", () => {
    const step: Step = { id: "s", t: 0, action: "navigate", url: "/next" };
    expect(dispatchAction(step, null)).toEqual({ kind: "navigate", url: "/next" });
  });
});
