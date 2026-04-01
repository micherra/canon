export interface EntityInfo {
  name: string;
  kind: string;
  is_exported: boolean;
  line_start?: number;
  line_end?: number;
}

export interface GraphNode {
  id: string;
  layer: string;
  color?: string;
  violation_count?: number;
  top_violations?: string[];
  changed?: boolean;
  summary?: string;
  exports?: string[];
  kind?: string;
  entity_count?: number;
  export_count?: number;
  dead_code_count?: number;
  community?: number;
  entities?: EntityInfo[];
}

export interface GraphEdge {
  source: string | { id: string };
  target: string | { id: string };
  kind?: string;
  relation?: string;
  confidence?: number;
  type?: string;
}

export interface PrincipleInfo {
  title: string;
  severity: string;
  summary: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers?: Array<{ name: string; color: string; file_count: number; index?: number }>;
  insights?: unknown;
  principles?: Record<string, PrincipleInfo>;
}

/** Index-encoded compact graph from the MCP tool. */
export interface CompactGraphData {
  _compact: true;
  node_ids: string[];
  nodes: Array<{
    l: string;
    v?: number;
    t?: string[];
    c?: boolean;
    k?: string;
  }>;
  edges: [number, number][];
  layers: GraphData["layers"];
  generated_at: string;
}

/** Decode a compact graph into the standard GraphData the UI expects. */
export function decodeCompactGraph(compact: CompactGraphData): GraphData {
  const nodes: GraphNode[] = compact.node_ids.map((id, i) => {
    const n = compact.nodes[i];
    return {
      id,
      layer: n.l,
      violation_count: n.v ?? 0,
      top_violations: n.t ?? [],
      changed: n.c ?? false,
      kind: n.k,
    };
  });
  const edges: GraphEdge[] = compact.edges.map(([si, ti]) => ({
    source: compact.node_ids[si],
    target: compact.node_ids[ti],
  }));
  return { nodes, edges, layers: compact.layers };
}
