/**
 * Steps 3-4 of the auto-zoom pipeline (BUILD_PLAN §6.4): greedy single-pass clustering of
 * scored events, then filtering of weak clusters.
 */
import { normDistance } from "@dolly/schema";
import type { ScoredEvent } from "./score.js";
import type { AutoZoomParams } from "./params.js";

export interface Cluster {
  events: ScoredEvent[];
  centroidX: number;
  centroidY: number;
  totalScore: number;
  hasClick: boolean;
  firstT: number;
  lastT: number;
}

function newCluster(e: ScoredEvent): Cluster {
  return {
    events: [e],
    centroidX: e.x,
    centroidY: e.y,
    totalScore: e.score,
    hasClick: e.click,
    firstT: e.t,
    lastT: e.t,
  };
}

function push(c: Cluster, e: ScoredEvent): void {
  c.events.push(e);
  const n = c.events.length;
  c.centroidX += (e.x - c.centroidX) / n;
  c.centroidY += (e.y - c.centroidY) / n;
  c.totalScore += e.score;
  c.hasClick = c.hasClick || e.click;
  c.lastT = e.t;
}

/**
 * Greedy agglomeration (§6.4 step 3): an event joins the open cluster iff its time gap to
 * the cluster's last event is `< mergeGap` AND its normalized distance to the running
 * centroid is `< mergeRadius`; otherwise the cluster closes and a new one opens.
 */
export function clusterEvents(scored: ScoredEvent[], p: AutoZoomParams): Cluster[] {
  const sorted = [...scored].sort((a, b) => a.t - b.t);
  const clusters: Cluster[] = [];
  let open: Cluster | null = null;
  for (const e of sorted) {
    if (
      open &&
      e.t - open.lastT < p.mergeGap &&
      normDistance(e.x, e.y, open.centroidX, open.centroidY) < p.mergeRadius
    ) {
      push(open, e);
    } else {
      open = newCluster(e);
      clusters.push(open);
    }
  }
  return clusters;
}

/**
 * Filter (§6.4 step 4): drop clusters whose total score `< 0.5`, or whose duration is
 * `< minDwell` and which contain no click.
 */
export function filterClusters(clusters: Cluster[], p: AutoZoomParams): Cluster[] {
  return clusters.filter((c) => {
    if (c.totalScore < 0.5) return false;
    const duration = c.lastT - c.firstT;
    if (duration < p.minDwell && !c.hasClick) return false;
    return true;
  });
}
