/**
 * Generate a ranked set of locators for a DOM element (the "describe" half of the self-healing
 * engine). Each strategy carries a stability weight; the highest-weight viable locator becomes
 * `primary`, the rest are ordered `fallbacks`.
 */
import type { Locator, LocatorSet, LocatorStrategy } from "@dolly/schema";
import {
  TEST_ID_ATTRS,
  STABLE_ATTRS,
  accessibleName,
  cssAttrValue,
  cssIdent,
  cssPath,
  isUnique,
  queryAllSafe,
  roleOf,
  stableAttrs,
  tagName,
  visibleText,
  xpathOf,
} from "./dom.js";

export interface DescribeOptions {
  /** extra attribute names to treat as test ids */
  testIdAttrs?: string[];
}

/** Heuristic: does this id look framework-generated (unstable)? */
function looksGenerated(id: string): boolean {
  return (
    /\d{4,}/.test(id) ||
    /[a-f0-9]{8,}/i.test(id) ||
    id.includes(":") ||
    /^(mui-|ember|ext-|react-|radix-|headlessui|aria-|:r)/i.test(id)
  );
}

function isTextual(tag: string, role: string | null): boolean {
  return (
    role === "button" ||
    role === "link" ||
    role === "heading" ||
    ["button", "a", "summary", "label"].includes(tag)
  );
}

function uniqueByText(doc: Document, tag: string, text: string): boolean {
  const matches = queryAllSafe(doc, tag).filter((el) => visibleText(el) === text);
  return matches.length === 1;
}

function uniqueAttrSelector(
  doc: Document,
  tag: string,
  attrs: Record<string, string>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const s = `${tag}[${k}="${cssAttrValue(attrs[k]!)}"]`;
    if (isUnique(doc, s)) return s;
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const s =
        `${tag}[${keys[i]}="${cssAttrValue(attrs[keys[i]!]!)}"]` +
        `[${keys[j]}="${cssAttrValue(attrs[keys[j]!]!)}"]`;
      if (isUnique(doc, s)) return s;
    }
  }
  return null;
}

/** Text of a <label> associated with the element, if any (for the `relative` strategy). */
function associatedLabelText(el: Element): string | null {
  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${cssAttrValue(el.id)}"]`);
    if (forLabel) return visibleText(forLabel);
  }
  const wrapping = el.closest("label");
  if (wrapping) return visibleText(wrapping);
  return null;
}

export function describe(el: Element, doc: Document, opts: DescribeOptions = {}): LocatorSet {
  const cands: Locator[] = [];
  const tag = tagName(el);
  const role = roleOf(el);
  const testIdAttrs = opts.testIdAttrs ? [...opts.testIdAttrs, ...TEST_ID_ATTRS] : TEST_ID_ATTRS;

  // 1. test id (most intentional / stable)
  for (const a of testIdAttrs) {
    const v = el.getAttribute(a);
    if (v) {
      const sel = `[${a}="${cssAttrValue(v)}"]`;
      if (isUnique(doc, sel)) cands.push({ strategy: "testid", value: sel, weight: 0.98 });
      break;
    }
  }

  // 2. id
  if (el.id) {
    const sel = `#${cssIdent(el.id)}`;
    if (isUnique(doc, sel)) {
      cands.push({ strategy: "id", value: sel, weight: looksGenerated(el.id) ? 0.6 : 0.95 });
    }
  }

  // 3. aria (role + accessible name)
  const name = accessibleName(el);
  if (role && name) cands.push({ strategy: "aria", value: `${role}:${name}`, weight: 0.9 });

  // 4. unique combination of stable attributes
  const attrs = stableAttrs(el);
  const attrKeys = STABLE_ATTRS.filter((k) => attrs[k] !== undefined);
  if (attrKeys.length > 0) {
    const sel = uniqueAttrSelector(doc, tag, attrs, attrKeys);
    if (sel) cands.push({ strategy: "attr", value: sel, weight: 0.75 });
  }

  // 5. visible text (interactive elements)
  const text = visibleText(el);
  if (text && text.length <= 40 && isTextual(tag, role) && uniqueByText(doc, tag, text)) {
    cands.push({ strategy: "text", value: `${tag}|${text}`, weight: 0.65 });
  }

  // 6. relative (anchored to an associated label)
  const labelText = associatedLabelText(el);
  if (labelText) cands.push({ strategy: "relative", value: `label:${labelText}`, weight: 0.55 });

  // 7. shortest-unique CSS path
  const path = cssPath(el, doc);
  if (path) cands.push({ strategy: "css", value: path, weight: 0.5 });

  // 8. structural XPath
  cands.push({ strategy: "xpath", value: xpathOf(el), weight: 0.4 });

  // 9. geometric fallback (tag only; the recorded rect lives on the Step and is used at resolve)
  cands.push({ strategy: "geom", value: tag, weight: 0.2 });

  // rank: highest weight first, dedup identical (strategy,value)
  const seen = new Set<string>();
  const ranked = cands
    .filter((c) => {
      const k = `${c.strategy}|${c.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.weight - a.weight);

  const primary = ranked[0] ?? ({ strategy: "geom" as LocatorStrategy, value: tag, weight: 0.2 });
  return { primary, fallbacks: ranked.filter((c) => c !== primary) };
}
