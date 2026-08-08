/** Text utilities for locator matching and self-healing similarity scoring. */

/** Normalize visible text: collapse whitespace, trim, lowercase. */
export function normText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Levenshtein edit distance (iterative, O(mn) with a single row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1]! === b[j - 1]! ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Character similarity in [0,1] from edit distance. */
export function charSimilarity(a: string, b: string): number {
  const na = normText(a);
  const nb = normText(b);
  if (na === "" && nb === "") return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/** Jaccard token overlap in [0,1]. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normText(a).split(" ").filter(Boolean));
  const tb = new Set(normText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Blended text similarity: the stronger of token overlap and character similarity. */
export function textSimilarity(a: string, b: string): number {
  return Math.max(tokenSimilarity(a, b), charSimilarity(a, b));
}
