// @vitest-environment jsdom
/**
 * Integration proof: a Recording built from the mock product's real markup (via the actual
 * selector engine) drives that DOM to the expected state through the player's driver — first on
 * the pristine page, then after the page's ids/test-ids drift, exercising self-healing end to end.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveStep, dispatchAction, effectiveMode } from "@dolly/player";
import { PRODUCT_HTML, wireProduct } from "../src/product.js";
import { buildSampleRecording } from "../src/sample.js";
import type { Recording } from "@dolly/schema";

function render(): void {
  document.body.innerHTML = `<div id="product">${PRODUCT_HTML}</div>`;
  wireProduct(document);
}

/** Run every step in auto-run against the current document. */
function drive(rec: Recording): { resolved: number; healed: number } {
  let resolved = 0;
  let healed = 0;
  for (const step of rec.steps) {
    effectiveMode(step, "auto"); // exercised for parity with the live loop
    const res = resolveStep(step, document, { viewport: { w: 1280, h: 800 } });
    if (res.status !== "ready" || !res.el) continue;
    resolved += 1;
    if (res.result?.healed) healed += 1;
    dispatchAction(step, res.el);
  }
  return { resolved, healed };
}

function finalState(): { name: string; plan: string; news: boolean; result: string } {
  const name = document.querySelector<HTMLInputElement>('[name="displayName"]')!.value;
  const plan = document.querySelector<HTMLSelectElement>('[name="plan"]')!.value;
  const news = document.querySelector<HTMLInputElement>('[name="newsletter"]')!.checked;
  const result = document.getElementById("result")?.textContent ?? "";
  return { name, plan, news, result };
}

describe("demo integration — auto-run drives the real form", () => {
  beforeEach(render);

  it("performs every recorded step on the pristine page", () => {
    const rec = buildSampleRecording(document);
    const { resolved } = drive(rec);
    expect(resolved).toBe(rec.steps.length);

    const s = finalState();
    expect(s.name).toBe("Ada Lovelace");
    expect(s.plan).toBe("pro");
    expect(s.news).toBe(true);
    expect(s.result).toContain("Ada Lovelace");
    expect(s.result).toContain("pro");
  });

  it("still resolves and performs every step after the DOM drifts", () => {
    // Record against the pristine page…
    const rec = buildSampleRecording(document);

    // …then the product ships a new build: ids and test-ids change out from under the recording.
    document.querySelectorAll("[data-testid]").forEach((el) => {
      const v = el.getAttribute("data-testid");
      if (v) el.setAttribute("data-testid", `${v}-2026`);
    });
    document.getElementById("settings")?.setAttribute("id", "settings-panel");

    const { resolved } = drive(rec);
    expect(resolved).toBe(rec.steps.length);

    const s = finalState();
    expect(s.name).toBe("Ada Lovelace");
    expect(s.plan).toBe("pro");
    expect(s.news).toBe(true);
    expect(s.result).toContain("Ada Lovelace");
  });

  it("coaches the destructive/submit step by default", () => {
    const rec = buildSampleRecording(document);
    const submit = rec.steps.find((st) => st.action === "submit")!;
    expect(effectiveMode(submit, "auto")).toBe("coach"); // its liveMode is coach
  });
});
