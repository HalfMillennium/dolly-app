/**
 * DOLLY auto-zoom (BUILD_PLAN §6.4).
 *
 * `generateZooms` is pure and deterministic: same input -> same output, no filesystem, DOM,
 * clock, or randomness. It runs in the frontend on demand (on recording completion and on
 * "Regenerate"). The emitted segments are ordinary editable Zoom objects tagged
 * `origin:"auto"`; the caller is responsible for preserving `origin:"manual"` segments when
 * merging a regenerated set (see mergeAuto below).
 */
import type { Zoom, CursorEvent } from "@dolly/schema";
import { resampleAndFilter } from "./track.js";
import { scoreEvents } from "./score.js";
import { clusterEvents, filterClusters } from "./cluster.js";
import { emitSegments, resolveConflicts, applyBudget, toZooms } from "./emit.js";
import {
  DEFAULT_PARAMS,
  type AutoZoomParams,
  type AutoZoomControls,
  paramsFromControls,
} from "./params.js";

export interface GenerateMeta {
  /** total (untrimmed) media duration in seconds */
  duration: number;
  /** source aspect ratio (width / height) */
  aspect: number;
}

export {
  DEFAULT_PARAMS,
  DEFAULT_CONTROLS,
  paramsFromControls,
  type AutoZoomParams,
  type AutoZoomControls,
} from "./params.js";

// Pipeline primitives, re-exported for sibling packages (e.g. @dolly/cursoropt) that need to
// extract "targets" from a cursor track without reimplementing resampling/scoring/clustering.
export { positionSampler, resampleAndFilter, type Sample } from "./track.js";
export { scoreEvents, type ScoredEvent, type ScoreOptions } from "./score.js";
export { clusterEvents, filterClusters, type Cluster } from "./cluster.js";

/**
 * Generate zoom segments from a cursor telemetry track. Steps 1-8 of §6.4.
 *
 * @param cursor  parsed cursor.jsonl events, any order (sorted internally)
 * @param meta    media duration + aspect
 * @param params  full parameter set; defaults to the BUILD_PLAN §6.4 table
 */
export function generateZooms(
  cursor: CursorEvent[],
  meta: GenerateMeta,
  params: AutoZoomParams = DEFAULT_PARAMS,
): Zoom[] {
  if (meta.duration <= 0 || cursor.length === 0) return [];

  // 1. resample + One Euro filter
  const { samples, sample } = resampleAndFilter(
    cursor,
    meta.duration,
    params.resampleHz,
    params.minCutoff,
    params.beta,
  );

  // 2. score events (clicksOnly is off here; the controls variant flips it)
  const scored = scoreEvents(cursor, samples, sample, { clicksOnly: false });

  // 3-4. cluster + filter
  const clusters = filterClusters(clusterEvents(scored, params), params);

  // 5. emit
  let segments = emitSegments(clusters, meta.duration, params);

  // 6. resolve conflicts
  segments = resolveConflicts(segments, params);

  // 7. budget
  segments = applyBudget(segments, meta.duration, params);

  // 8. to Zoom[]
  return toZooms(segments, params);
}

/**
 * Convenience wrapper driven by the three user-facing controls (§6.4 UI affordance). The
 * `clicksOnly` toggle is applied at the scoring stage.
 */
export function generateZoomsFromControls(
  cursor: CursorEvent[],
  meta: GenerateMeta,
  controls: AutoZoomControls,
): Zoom[] {
  const params = paramsFromControls(controls);
  if (!controls.clicksOnly) return generateZooms(cursor, meta, params);

  // clicks-only: rerun scoring with the toggle set
  if (meta.duration <= 0 || cursor.length === 0) return [];
  const { samples, sample } = resampleAndFilter(
    cursor,
    meta.duration,
    params.resampleHz,
    params.minCutoff,
    params.beta,
  );
  const scored = scoreEvents(cursor, samples, sample, { clicksOnly: true });
  let segments = emitSegments(
    filterClusters(clusterEvents(scored, params), params),
    meta.duration,
    params,
  );
  segments = applyBudget(resolveConflicts(segments, params), meta.duration, params);
  return toZooms(segments, params);
}

/**
 * Merge a freshly-generated auto set into an existing zoom list, preserving user intent
 * (BUILD_PLAN §3.3): `origin:"manual"` segments are kept untouched; previous `origin:"auto"`
 * segments are replaced by the new ones. Auto segments overlapping a manual one are dropped
 * so the user's edits always win. Returns a new, time-sorted array; ids are re-issued for the
 * auto segments to stay unique.
 */
export function mergeAuto(existing: Zoom[], fresh: Zoom[]): Zoom[] {
  const manual = existing.filter((z) => z.origin === "manual");
  const overlapsManual = (z: Zoom): boolean =>
    manual.some((m) => z.start < m.end && m.start < z.end);
  const keptAuto = fresh.filter((z) => !overlapsManual(z));
  const merged = [...manual, ...keptAuto].sort((a, b) => a.start - b.start);
  let autoN = 0;
  let manualN = 0;
  return merged.map((z) =>
    z.origin === "auto"
      ? { ...z, id: `z${++autoN}` }
      : { ...z, id: z.id || `m${++manualN}` },
  );
}
