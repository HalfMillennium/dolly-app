// @vitest-environment jsdom
/**
 * Self-healing selector regression suite. For each scenario we `describe` an element in a
 * "record-time" DOM, then `resolve` the resulting LocatorSet against a "drifted" DOM and assert
 * it still lands on the intended element (marked `data-truth="1"` — an attribute the engine
 * ignores). Covers stable ids, renamed ids, edited text, wrapped/moved nodes, added attributes,
 * and a changed tag.
 */
import { describe as vdescribe, it, expect } from "vitest";
import { describe as locate, resolve, textSimilarity } from "../src/index.js";

function makeDoc(body: string): Document {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = body;
  return doc;
}

/** describe the element matched by `sel` in a fresh record-time doc. */
function record(body: string, sel: string) {
  const doc = makeDoc(body);
  const el = doc.querySelector(sel);
  if (!el) throw new Error(`record selector matched nothing: ${sel}`);
  return locate(el, doc);
}

function truth(result: { el: Element } | null): string | null {
  return result?.el.getAttribute("data-truth") ?? null;
}

vdescribe("exact resolution (no drift)", () => {
  it("resolves a test-id primary", () => {
    const set = record(`<button data-testid="save" class="a">Save</button>`, "button");
    expect(set.primary.strategy).toBe("testid");
    const doc = makeDoc(`<button data-testid="save" data-truth="1" class="totally-different">Save it</button>`);
    const r = resolve(set, doc);
    expect(r?.healed).toBe(false);
    expect(truth(r)).toBe("1");
  });
});

vdescribe("self-healing under drift", () => {
  it("heals when the id was renamed (falls back to role+text)", () => {
    const set = record(`<div><button id="btn-9f3a">Continue</button></div>`, "#btn-9f3a");
    const drift = makeDoc(`<div><button id="btn-changed" data-truth="1">Continue</button></div>`);
    const r = resolve(set, drift);
    expect(truth(r)).toBe("1");
  });

  it("finds the button after light text + class churn", () => {
    const set = record(`<button class="primary">Save changes</button>`, "button");
    const drift = makeDoc(`<button class="renamed" data-truth="1">Save Changes now</button>`);
    expect(truth(resolve(set, drift))).toBe("1");
  });

  it("genuinely heals (scoring) when structural + id locators all break", () => {
    // two same-tag siblings; target identified only by its (edited) text after a reorder + id churn
    const set = record(
      `<div><button id="btn-1a2b">Submit form</button><button id="btn-9z8y">Cancel</button></div>`,
      "#btn-1a2b",
    );
    const drift = makeDoc(
      `<div><button id="c-001">Cancel</button><button id="s-002" data-truth="1">Submit the form</button></div>`,
    );
    const r = resolve(set, drift);
    expect(r?.healed).toBe(true); // no exact locator survives; scoring picks the right sibling
    expect(truth(r)).toBe("1");
  });

  it("heals when the element was wrapped in extra nodes (css path drift)", () => {
    const set = record(
      `<form><input name="email" type="email" placeholder="Email"></form>`,
      'input[name="email"]',
    );
    // an extra wrapper div changes the structural path; attrs are intact
    const drift = makeDoc(
      `<form><div class="field"><div class="control"><input name="email" type="email" placeholder="Email" data-truth="1"></div></div></form>`,
    );
    const r = resolve(set, drift);
    expect(truth(r)).toBe("1");
  });

  it("heals when siblings were reordered (nth-of-type drift)", () => {
    const set = record(
      `<ul><li><a href="/a">Alpha</a></li><li><a href="/b">Bravo</a></li></ul>`,
      'a[href="/b"]',
    );
    const drift = makeDoc(
      `<ul><li><a href="/b" data-truth="1">Bravo</a></li><li><a href="/a">Alpha</a></li><li><a href="/c">Charlie</a></li></ul>`,
    );
    const r = resolve(set, drift);
    expect(truth(r)).toBe("1");
  });

  it("still resolves when extra attributes/classes were added (primary holds)", () => {
    const set = record(`<button data-testid="go">Go</button>`, "button");
    const drift = makeDoc(`<button data-testid="go" data-truth="1" aria-busy="true" class="x y z">Go</button>`);
    const r = resolve(set, drift);
    expect(r?.healed).toBe(false);
    expect(truth(r)).toBe("1");
  });

  it("survives a tag change (button -> a[role=button]) via role+text", () => {
    const set = record(`<button>Download report</button>`, "button");
    const drift = makeDoc(`<a href="#" role="button" data-truth="1">Download report</a>`);
    expect(truth(resolve(set, drift))).toBe("1");
  });

  it("resolves a labeled input via the relative (label) strategy after id churn", () => {
    const set = record(
      `<label for="pn">Project name</label><input id="pn" name="projectName">`,
      "#pn",
    );
    const drift = makeDoc(
      `<label for="pn-42">Project name</label><input id="pn-42" name="projectName" data-truth="1">`,
    );
    const r = resolve(set, drift);
    expect(truth(r)).toBe("1");
  });

  it("uses geometric proximity to disambiguate identical siblings", () => {
    const set = record(`<button class="tab">Tab</button><button class="tab">Tab</button>`, "button:nth-of-type(2)");
    const drift = makeDoc(`<button class="tab">Tab</button><button class="tab" data-truth="1">Tab</button>`);
    // stub rects: the second button sits lower-right, matching the recorded rect
    const btns = drift.querySelectorAll("button");
    stubRect(btns[0]!, { left: 0, top: 0, width: 50, height: 20 });
    stubRect(btns[1]!, { left: 500, top: 400, width: 50, height: 20 });
    const r = resolve(set, drift, {
      rect: { x: 0.5, y: 0.5, w: 0.05, h: 0.02 },
      viewport: { w: 1000, h: 800 },
    });
    expect(truth(r)).toBe("1");
  });
});

vdescribe("negative — genuinely gone", () => {
  it("returns null when the target is absent and nothing is similar", () => {
    const set = record(`<button data-testid="save">Save the document</button>`, "button");
    const drift = makeDoc(`<p>Nothing actionable here at all.</p>`);
    const r = resolve(set, drift);
    expect(r).toBeNull();
  });
});

vdescribe("text similarity", () => {
  it("scores near-identical strings high and unrelated strings low", () => {
    expect(textSimilarity("Save changes", "Save Changes now")).toBeGreaterThan(0.5);
    expect(textSimilarity("Save", "Delete account")).toBeLessThan(0.3);
  });
});

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}
