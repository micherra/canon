/** Walk the dependency graph to find all downstream dependents (cascade) */
export function computeCascade(
  nodeId: string,
  edgeIn: Map<string, string[]>,
  maxDepth = 4,
): Set<string>[] {
  const levels: Set<string>[] = [];
  const visited = new Set([nodeId]);
  let frontier = new Set([nodeId]);

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextLevel = new Set<string>();
    for (const id of frontier) {
      const dependents = edgeIn.get(id) || [];
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          nextLevel.add(dep);
        }
      }
    }
    if (nextLevel.size === 0) break;
    levels.push(nextLevel);
    frontier = nextLevel;
  }
  return levels;
}

/** Get all files in the cascade as a flat set */
export function getCascadeFiles(nodeId: string, edgeIn: Map<string, string[]>): Set<string> {
  const levels = computeCascade(nodeId, edgeIn);
  const all = new Set<string>();
  for (const level of levels) {
    for (const f of level) all.add(f);
  }
  return all;
}

/** Get the layer for a file ID */
export function getNodeLayer(id: string, layerMap: Map<string, string>): string {
  return layerMap.get(id) || "unknown";
}

/** Extract basename from a file path */
export function basename(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/** Collect file IDs for an insight category */
export function getInsightFiles(type: string, data: { nodes: any[]; edges: any[]; insights?: any }): Set<string> {
  const ins = data.insights || {};
  const files = new Set<string>();

  if (type === "violations") {
    for (const v of ins.layer_violations || []) {
      if (v.source) files.add(v.source);
      if (v.target) files.add(v.target);
    }
    for (const n of data.nodes) {
      if ((n.violation_count || 0) > 0) files.add(n.id);
    }
  } else if (type === "cycles") {
    for (const cycle of ins.circular_dependencies || []) {
      for (const f of cycle) files.add(f);
    }
  } else if (type === "orphans") {
    for (const f of ins.orphan_files || []) files.add(f);
  } else if (type === "connected") {
    for (const n of ins.most_connected || []) files.add(n.path);
  } else if (type === "changed") {
    for (const n of data.nodes.filter((n: any) => n.changed)) files.add(n.id);
  }

  return files;
}

/** Parse a search query for prefix filters */
export function parseSearchQuery(raw: string) {
  const trimmed = raw.trim();
  let filterLayer: string | null = null;
  let filterChanged = false;
  let filterViolation = false;
  let textQuery = trimmed;

  const layerMatch = trimmed.match(/^layer:(\S+)\s*(.*)/i);
  if (layerMatch) {
    filterLayer = layerMatch[1].toLowerCase();
    textQuery = layerMatch[2];
  }

  const changedMatch = trimmed.match(/^changed(?::true)?\s*(.*)/i);
  if (changedMatch) {
    filterChanged = true;
    textQuery = changedMatch[1];
  }

  const violationMatch = trimmed.match(/^violations?\s*(.*)/i);
  if (violationMatch) {
    filterViolation = true;
    textQuery = violationMatch[1];
  }

  return { textQuery: textQuery.trim(), filterLayer, filterChanged, filterViolation };
}
