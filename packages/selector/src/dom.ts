/** DOM helpers for locator generation + resolution (framework-free, jsdom-compatible). */
import { normText } from "./text.js";

export function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

/** True if `sel` matches exactly one element in `doc` (querySelector, guarded). */
export function isUnique(doc: Document, sel: string): boolean {
  try {
    return doc.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

export function queryAllSafe(doc: Document, sel: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(sel));
  } catch {
    return [];
  }
}

/** The common test-id attribute names, in priority order. */
export const TEST_ID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];

/** Attributes considered stable enough to identify an element (excludes class/style/data-*). */
export const STABLE_ATTRS = ["name", "type", "placeholder", "aria-label", "alt", "title", "href", "role"];

/** Implicit ARIA role for an element (small, interactive-focused map), or null. */
export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().toLowerCase();
  const tag = tagName(el);
  switch (tag) {
    case "a":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
      return "button";
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "img":
      return "img";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["text", "email", "search", "tel", "url", "password", "number"].includes(type)) return "textbox";
      return "textbox";
    }
    default:
      return null;
  }
}

/** Visible text of an element, normalized and length-capped. */
export function visibleText(el: Element): string {
  return normText(el.textContent).slice(0, 80);
}

/**
 * Approximate accessible name (a practical subset of the ARIA name computation):
 * aria-label → aria-labelledby text → associated <label> → title/alt/placeholder → element text.
 */
export function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return normText(label);

  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const doc = el.ownerDocument;
    const parts = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => visibleText(n));
    if (parts.join(" ").trim()) return normText(parts.join(" "));
  }

  // associated <label for=id> or wrapping <label>
  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${cssAttrValue(el.id)}"]`);
    if (forLabel) return visibleText(forLabel);
  }
  const wrapping = el.closest("label");
  if (wrapping) return visibleText(wrapping);

  const title = el.getAttribute("title");
  if (title && title.trim()) return normText(title);
  const alt = el.getAttribute("alt");
  if (alt && alt.trim()) return normText(alt);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return normText(placeholder);

  return visibleText(el);
}

/** Escape a string for use inside a CSS attribute-value in double quotes. */
export function cssAttrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A CSS selector for one element among its same-tag siblings. */
function segment(el: Element): string {
  const tag = tagName(el);
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag: Element[] = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sameTag.length === 1) return tag;
  const idx = sameTag.indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

/**
 * Shortest-unique-ish CSS path: climb toward the root, stopping early at a stable id or as soon
 * as the accumulated suffix is unique in the document.
 */
export function cssPath(el: Element, doc: Document): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur.tagName !== "HTML" && cur.tagName !== "BODY") {
    if (cur.id) {
      const s = `#${cssIdent(cur.id)}`;
      if (isUnique(doc, s)) {
        parts.unshift(s);
        return parts.join(" > ");
      }
    }
    parts.unshift(segment(cur));
    const sel = parts.join(" > ");
    if (isUnique(doc, sel)) return sel;
    cur = cur.parentElement;
  }
  return parts.join(" > ") || tagName(el);
}

/** Escape a string for use as a CSS identifier (#id). Falls back conservatively. */
export function cssIdent(v: string): string {
  return v.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/** An absolute XPath in a fixed `/tag[idx]/...` shape we can also resolve ourselves. */
export function xpathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    const node: Element = cur;
    const tag = tagName(node);
    const parent = node.parentElement;
    if (!parent) {
      parts.unshift(`/${tag}`);
      break;
    }
    const sameTag: Element[] = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    const idx = sameTag.indexOf(node) + 1;
    parts.unshift(`/${tag}[${idx}]`);
    cur = parent;
  }
  return parts.join("");
}

/** Resolve one of our own `/tag[idx]/...` XPaths by walking the tree (jsdom has no evaluate). */
export function resolveSimpleXPath(xp: string, doc: Document): Element | null {
  const steps = xp.split("/").filter(Boolean);
  // first step targets the root element (html)
  if (steps.length === 0) return null;
  const first = steps[0]!;
  const firstTag = first.replace(/\[\d+\]$/, "");
  if (!doc.documentElement || doc.documentElement.tagName.toLowerCase() !== firstTag) return null;
  let cur: Element | null = doc.documentElement;
  for (let i = 1; i < steps.length; i++) {
    const node: Element | null = cur;
    if (!node) return null;
    const m = /^([a-z0-9-]+)\[(\d+)\]$/.exec(steps[i]!);
    if (!m) return null;
    const tag = m[1]!;
    const idx = Number(m[2]!);
    const sameTag: Element[] = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === tag);
    cur = sameTag[idx - 1] ?? null;
  }
  return cur;
}

/** Center of an element's bounding rect, normalized to the viewport (best-effort in jsdom). */
export function normRect(
  el: Element,
  viewport: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const vw = viewport.w || 1;
  const vh = viewport.h || 1;
  return { x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh };
}

/** Stable attributes present on an element, as a plain record. */
export function stableAttrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null && v !== "") out[a] = v;
  }
  for (const a of TEST_ID_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null && v !== "") out[a] = v;
  }
  return out;
}
