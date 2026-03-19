/** Graph-aware file priority scoring for PR review — pure functions, no I/O */

import { LAYER_CENTRALITY } from "../constants.js";
import { buildDegreeMaps } from "./degree.js";

export interface FilePriorityScore {
  path: string;
  priority_score: number;
  factors: {
    in_degree: number;
    violation_count: number;
    is_changed: boolean;
    layer: string;
    layer_centrality: number;
  };
}

interface PriorityNode {
  id: string;
  layer: string;
  violation_count: number;
  changed: boolean;
}

interface PriorityEdge {
  source: string;
  target: string;
}

// LAYER_CENTRALITY imported from constants.ts

/**
 * Compute priority scores for files based on graph structure.
 * Higher scores = more impactful files that deserve closer review.
 *
 * Score = (in_degree × 3) + (violation_count × 2) + (changed ? 1 : 0) + layer_centrality
 */
export function computeFilePriorities(
  nodes: PriorityNode[],
  edges: PriorityEdge[],
  filterToChanged = true,
): FilePriorityScore[] {
  const { inDegree } = buildDegreeMaps(
    nodes.map((n) => n.id),
    edges,
  );

  const candidates = filterToChanged ? nodes.filter((n) => n.changed) : nodes;

  return candidates
    .map((n) => {
      const deg = inDegree.get(n.id) || 0;
      const centrality = LAYER_CENTRALITY[n.layer] ?? 0;
      const score =
        deg * 3 +
        n.violation_count * 2 +
        (n.changed ? 1 : 0) +
        centrality;

      return {
        path: n.id,
        priority_score: Math.round(score * 100) / 100,
        factors: {
          in_degree: deg,
          violation_count: n.violation_count,
          is_changed: n.changed,
          layer: n.layer,
          layer_centrality: centrality,
        },
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score);
}
