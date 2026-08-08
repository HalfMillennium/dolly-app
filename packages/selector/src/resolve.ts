/**
 * Resolve a LocatorSet back to a DOM element — the self-healing half of the engine.
 *
 * 1. Exact pass: try primary then fallbacks; a locator that resolves to exactly one element wins.
 * 2. Self-heal pass: when nothing resolves uniquely (the page drifted), score every plausible
 *    candidate by a blend of text similarity, attribute overlap, role/tag match, and geometric
 *    proximity to the recorded rect; return the best above a confidence threshold.
 */
import { normDistance, type Locator, type LocatorSet, type Rect2D } from "@dolly/schema";
import {
  TEST_ID_ATTRS,
  accessibleName,
  normRect,
  queryAllSafe,
  resolveSimpleXPath,
  roleOf,
  tagName,
  visibleText,
} from "./dom.js";
import { textSimilarity } from "./text.js";

export interface ResolveOptions {
  /** recorded element rect (viewport-normalized) — enables geometric self-healing */
  rect?: Rect2D;
  /** current viewport size, for normalizing candidate rects */
  viewport?: { w: number; h: number };
  /** minimum self-heal confidence to accept a match (default 0.55) */
  threshold?: number;
}

export interface ResolveResult {
  el: Element;
  locator: Locator;
  /** 1 for an exact match; the self-heal confidence otherwise */
  score: number;
  healed: boolean;
}

/** All elements a single locator matches (order-preserving). */
function resolveLocatorAll(loc: Locator, doc: Document): Element[] {
  switch (loc.strategy) {
    case "id":
    case "testid":
    case "attr":
    case "css":
      return queryAllSafe(doc, loc.value);
    case "aria": {
      const idx = loc.value.indexOf(":");
      const role = loc.value.slice(0, idx);
      const name = loc.value.slice(idx + 1);
      return queryAllSafe(doc, "*").filter(
        (el) => roleOf(el) === role && accessibleName(el) === name,
      );
    }
    case "text": {
      const idx = loc.value.indexOf("|");
      const tag = loc.value.slice(0, idx);
      const text = loc.value.slice(idx + 1);
      return queryAllSafe(doc, tag).filter((el) => visibleText(el) === text);
    }
    case "relative": {
      // `label:<text>` → the control associated with a label of that text
      if (loc.value.startsWith("label:")) {
        const text = loc.value.slice("label:".length);
        const label = queryAllSafe(doc, "label").find((l) => visibleText(l) === text) as
          | HTMLLabelElement
          | undefined;
        if (!label) return [];
        const forId = label.getAttribute("for");
        if (forId) {
          const el = doc.getElementById(forId);
          return el ? [el] : [];
        }
        const nested = label.querySelector("input, select, textarea, button");
        return nested ? [nested] : [];
      }
      return [];
    }
    case "xpath": {
      const el = resolveSimpleXPath(loc.value, doc);
      return el ? [el] : [];
    }
    case "geom":
      return []; // geom is heal-only (needs the recorded rect)
  }
}

/** Signals reconstructed from a locator set, used to score self-heal candidates. */
interface Expected {
  tag?: string;
  role?: string;
  text?: string;
  attrs: Record<string, string>;
  testId?: string;
}

function parseExpected(set: LocatorSet): Expected {
  const exp: Expected = { attrs: {} };
  const all = [set.primary, ...set.fallbacks];
  for (const loc of all) {
    switch (loc.strategy) {
      case "testid": {
        const m = /^\[([a-z-]+)="(.*)"\]$/i.exec(loc.value);
        if (m) {
          exp.attrs[m[1]!] = m[2]!;
          exp.testId = m[2]!;
        }
        break;
      }
      case "attr": {
        const tag = loc.value.match(/^[a-z0-9-]+/i)?.[0];
        if (tag) exp.tag ??= tag;
        for (const m of loc.value.matchAll(/\[([a-z-]+)="((?:[^"\\]|\\.)*)"\]/gi)) {
          exp.attrs[m[1]!] = m[2]!.replace(/\\"/g, '"');
        }
        break;
      }
      case "aria": {
        const idx = loc.value.indexOf(":");
        exp.role ??= loc.value.slice(0, idx);
        exp.text ??= loc.value.slice(idx + 1);
        break;
      }
      case "text": {
        const idx = loc.value.indexOf("|");
        exp.tag ??= loc.value.slice(0, idx);
        exp.text ??= loc.value.slice(idx + 1);
        break;
      }
      case "css": {
        const last = loc.value.split(">").pop()!.trim();
        const tag = last.match(/^[a-z0-9-]+/i)?.[0];
        if (tag && tag !== "") exp.tag ??= tag;
        break;
      }
      case "xpath": {
        const last = loc.value.split("/").filter(Boolean).pop();
        const tag = last?.replace(/\[\d+\]$/, "");
        if (tag) exp.tag ??= tag;
        break;
      }
      case "geom":
        exp.tag ??= loc.value;
        break;
      case "id":
        break;
    }
  }
  return exp;
}

function scoreCandidate(c: Element, exp: Expected, opts: ResolveOptions): number {
  const parts: Array<[number, number]> = []; // [value, weight]

  if (exp.text) {
    const s = Math.max(textSimilarity(visibleText(c), exp.text), textSimilarity(accessibleName(c), exp.text));
    parts.push([s, 0.35]);
  }
  const attrKeys = Object.keys(exp.attrs);
  if (attrKeys.length > 0) {
    let hit = 0;
    for (const k of attrKeys) if (c.getAttribute(k) === exp.attrs[k]) hit++;
    parts.push([hit / attrKeys.length, 0.25]);
  }
  if (exp.role) parts.push([roleOf(c) === exp.role ? 1 : 0, 0.15]);
  if (exp.tag) parts.push([tagName(c) === exp.tag ? 1 : 0, 0.12]);
  if (opts.rect && opts.viewport) {
    const r = normRect(c, opts.viewport);
    const d = normDistance(r.x + r.w / 2, r.y + r.h / 2, opts.rect.x + opts.rect.w / 2, opts.rect.y + opts.rect.h / 2);
    parts.push([Math.max(0, 1 - d), 0.18]);
  }

  if (parts.length === 0) return 0;
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const score = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;

  // A matching test id is decisive.
  if (exp.testId) {
    for (const a of TEST_ID_ATTRS) if (c.getAttribute(a) === exp.testId) return Math.max(score, 0.95);
  }
  return score;
}

/** Structural locators can accidentally match a different element after the DOM reorders. */
const STRUCTURAL = new Set(["css", "xpath", "geom"]);

/** Guard: a unique structural match is only trusted if it agrees with the expected signals. */
function structuralConsistent(el: Element, exp: Expected): boolean {
  if (exp.tag && tagName(el) !== exp.tag) return false;
  if (exp.text) {
    const s = Math.max(textSimilarity(visibleText(el), exp.text), textSimilarity(accessibleName(el), exp.text));
    if (s < 0.5) return false;
  }
  return true;
}

export function resolve(set: LocatorSet, doc: Document, opts: ResolveOptions = {}): ResolveResult | null {
  const exp = parseExpected(set);

  // 1. exact pass — a locator that resolves to exactly one element wins. Structural strategies
  // (css/xpath) must additionally pass a consistency guard, so a reorder can't silently hijack
  // the match to a same-tag sibling.
  for (const loc of [set.primary, ...set.fallbacks]) {
    const matches = resolveLocatorAll(loc, doc);
    if (matches.length !== 1) continue;
    const el = matches[0]!;
    if (STRUCTURAL.has(loc.strategy) && !structuralConsistent(el, exp)) continue;
    return { el, locator: loc, score: 1, healed: false };
  }

  // 2. self-heal — score plausible candidates and take the best above threshold.
  const threshold = opts.threshold ?? 0.55;
  const all = queryAllSafe(doc, "*");
  let best: Element | null = null;
  let bestScore = 0;
  for (const c of all) {
    // cheap pre-filter to keep the pool relevant
    const relevant =
      (exp.tag && tagName(c) === exp.tag) ||
      (exp.role && roleOf(c) === exp.role) ||
      (exp.testId && TEST_ID_ATTRS.some((a) => c.getAttribute(a) === exp.testId)) ||
      Object.keys(exp.attrs).some((k) => c.getAttribute(k) === exp.attrs[k]) ||
      (!!exp.text &&
        Math.max(textSimilarity(visibleText(c), exp.text), textSimilarity(accessibleName(c), exp.text)) > 0.5) ||
      (!!opts.rect && !!opts.viewport);
    if (!relevant) continue;
    const s = scoreCandidate(c, exp, opts);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  if (best && bestScore >= threshold) {
    return { el: best, locator: set.primary, score: bestScore, healed: true };
  }
  return null;
}
