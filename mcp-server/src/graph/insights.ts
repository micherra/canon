/** Codebase graph structural analysis — pure functions, no I/O */

export interface CodebaseInsights {
  overview: {
    total_files: number;
    total_edges: number;
    avg_dependencies_per_file: number;
    layers: Array<{ name: string; file_count: number }>;
  };
  most_connected: Array<{
    path: string;
    in_degree: number;
    out_degree: number;
    total: number;
  }>;
  orphan_files: string[];
  circular_dependencies: string[][];
  layer_violations: Array<{
    source: string;
    target: string;
    source_layer: string;
    target_layer: string;
  }>;
}

interface NodeLike {
  id: string;
  layer: string;
}

interface EdgeLike {
  source: string;
  target: string;
}

// Default clean-architecture layer rules: layer → allowed dependency targets
const DEFAULT_LAYER_RULES: Record<string, string[]> = {
  api: ["domain", "shared", "data"],
  ui: ["domain", "shared"],
  domain: ["data", "shared"],
  data: ["infra", "shared"],
  infra: ["shared"],
  shared: [],
};

export function generateInsights(
  nodes: NodeLike[],
  edges: EdgeLike[],
  layerRules?: Record<string, string[]>,
): CodebaseInsights {
  const rules = layerRules || DEFAULT_LAYER_RULES;

  // Degree maps
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
  }

  // Overview
  const layerCounts = new Map<string, number>();
  for (const node of nodes) {
    const layer = node.layer || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
  }

  const overview = {
    total_files: nodes.length,
    total_edges: edges.length,
    avg_dependencies_per_file:
      nodes.length > 0 ? Math.round((edges.length / nodes.length) * 100) / 100 : 0,
    layers: Array.from(layerCounts.entries())
      .map(([name, file_count]) => ({ name, file_count }))
      .sort((a, b) => b.file_count - a.file_count),
  };

  // Most connected (top 10 by total degree)
  const most_connected = nodes
    .map((n) => ({
      path: n.id,
      in_degree: inDegree.get(n.id) || 0,
      out_degree: outDegree.get(n.id) || 0,
      total: (inDegree.get(n.id) || 0) + (outDegree.get(n.id) || 0),
    }))
    .filter((n) => n.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Orphan files (zero connections)
  const orphan_files = nodes
    .filter((n) => (inDegree.get(n.id) || 0) === 0 && (outDegree.get(n.id) || 0) === 0)
    .map((n) => n.id)
    .sort();

  // Circular dependencies (DFS cycle detection, max cycle length 5)
  const circular_dependencies = detectCycles(nodes, edges);

  // Layer violations
  const nodeLayerMap = new Map<string, string>();
  for (const node of nodes) {
    nodeLayerMap.set(node.id, node.layer || "unknown");
  }

  const layer_violations: CodebaseInsights["layer_violations"] = [];
  for (const edge of edges) {
    const sourceLayer = nodeLayerMap.get(edge.source) || "unknown";
    const targetLayer = nodeLayerMap.get(edge.target) || "unknown";

    if (sourceLayer === targetLayer || sourceLayer === "unknown" || targetLayer === "unknown") {
      continue;
    }

    const allowed = rules[sourceLayer];
    if (allowed && !allowed.includes(targetLayer)) {
      layer_violations.push({
        source: edge.source,
        target: edge.target,
        source_layer: sourceLayer,
        target_layer: targetLayer,
      });
    }
  }

  return {
    overview,
    most_connected,
    orphan_files,
    circular_dependencies,
    layer_violations,
  };
}

/** Detect cycles using iterative DFS. Returns unique cycles up to length 5. */
function detectCycles(nodes: NodeLike[], edges: EdgeLike[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adj.get(edge.source);
    if (list) list.push(edge.target);
  }

  const MAX_CYCLE_LEN = 5;
  const cycles: string[][] = [];
  const cycleSet = new Set<string>();
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  // Iterative DFS using explicit call stack to avoid stack overflow on deep graphs
  // Each frame tracks: node, neighbor index (which neighbor to visit next)
  type Frame = { node: string; neighborIdx: number };

  for (const startNode of nodes) {
    if (visited.has(startNode.id) || cycles.length >= 20) continue;

    const callStack: Frame[] = [{ node: startNode.id, neighborIdx: 0 }];
    visited.add(startNode.id);
    inStack.add(startNode.id);
    path.push(startNode.id);

    while (callStack.length > 0 && cycles.length < 20) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adj.get(frame.node) || [];

      if (frame.neighborIdx >= neighbors.length) {
        // All neighbors explored — backtrack
        callStack.pop();
        path.pop();
        inStack.delete(frame.node);
        continue;
      }

      const neighbor = neighbors[frame.neighborIdx];
      frame.neighborIdx++;

      if (inStack.has(neighbor)) {
        // Found a cycle — extract it
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cycle = path.slice(cycleStart);
          if (cycle.length <= MAX_CYCLE_LEN) {
            const normalized = normalizeCycle(cycle);
            const key = normalized.join(" -> ");
            if (!cycleSet.has(key)) {
              cycleSet.add(key);
              cycles.push(normalized);
            }
          }
        }
      } else if (!visited.has(neighbor)) {
        visited.add(neighbor);
        inStack.add(neighbor);
        path.push(neighbor);
        callStack.push({ node: neighbor, neighborIdx: 0 });
      }
    }

    // Clean up if we exited early (cycle cap reached)
    for (const node of path) inStack.delete(node);
    path.length = 0;
  }

  return cycles;
}

/** Normalize a cycle by rotating so the lexicographically smallest element is first */
function normalizeCycle(cycle: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}
