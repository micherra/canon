/** Shared degree-map builder — eliminates duplication across insights, priority, and query. */

export type DegreeMaps = {
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
};

/** Build in-degree and out-degree maps from nodes and edges. */
export function buildDegreeMaps(
  nodeIds: Iterable<string>,
  edges: Iterable<{ source: string; target: string }>,
): DegreeMaps {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    outDegree.set(id, 0);
  }

  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
  }

  return { inDegree, outDegree };
}
