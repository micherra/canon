import { writable, derived } from "svelte/store";

export interface GraphNode {
  id: string;
  layer: string;
  violation_count?: number;
  changed?: boolean;
  summary?: string;
  exports?: string[];
  _has_violation?: boolean;
}

export interface GraphEdge {
  source: string | { id: string };
  target: string | { id: string };
  kind?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  insights?: any;
  hotspots?: any[];
}

export interface PrReview {
  verdict: string;
  score: any;
  violations: any[];
  files: string[];
}

export const graphData = writable<GraphData | null>(null);
export const prReviews = writable<Record<string, PrReview> | null>(null);

// Derived edge maps
export const edgeIn = derived(graphData, ($g) => {
  const map = new Map<string, string[]>();
  if (!$g?.edges) return map;
  for (const e of $g.edges) {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    if (!map.has(t)) map.set(t, []);
    map.get(t)!.push(s);
  }
  return map;
});

export const edgeOut = derived(graphData, ($g) => {
  const map = new Map<string, string[]>();
  if (!$g?.edges) return map;
  for (const e of $g.edges) {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(t);
  }
  return map;
});

export const nodeMap = derived(graphData, ($g) => {
  const map = new Map<string, GraphNode>();
  if (!$g?.nodes) return map;
  for (const n of $g.nodes) map.set(n.id, n);
  return map;
});

export const layerMap = derived(graphData, ($g) => {
  const map = new Map<string, string>();
  if (!$g?.nodes) return map;
  for (const n of $g.nodes) map.set(n.id, n.layer || "unknown");
  return map;
});

export const summaries = derived(graphData, ($g) => {
  const map: Record<string, string> = {};
  if (!$g?.nodes) return map;
  for (const n of $g.nodes) {
    if (n.summary) map[n.id] = n.summary;
  }
  return map;
});

// Derived insight counts (shared between HealthStrip and InsightsPanel)
export const violationCount = derived(graphData, ($g) => {
  if (!$g) return 0;
  const ins = $g.insights || {};
  return (ins.layer_violations || []).length +
    ($g.hotspots || []).reduce((sum: number, h: any) => sum + (h.violation_count || 0), 0);
});

export const cycleCount = derived(graphData, ($g) =>
  ($g?.insights?.circular_dependencies || []).length,
);

export const orphanCount = derived(graphData, ($g) =>
  ($g?.insights?.orphan_files || []).length,
);

/** Read JSON from embedded script tags and populate stores */
export function loadEmbeddedData() {
  const graphEl = document.getElementById("canon-graph-data");
  if (graphEl) {
    try {
      const text = graphEl.textContent?.trim() ?? "";
      if (!text.startsWith("__")) {
        const data = JSON.parse(text) as GraphData;

        // Mark layer violation source files
        const lvSources = new Set((data.insights?.layer_violations || []).map((v: any) => v.source));
        for (const node of data.nodes) {
          if (lvSources.has(node.id) && !(node.violation_count! > 0)) {
            node._has_violation = true;
          }
        }

        graphData.set(data);
      }
    } catch { /* empty */ }
  }

  const prEl = document.getElementById("canon-pr-reviews");
  if (prEl) {
    try {
      const text = prEl.textContent?.trim() ?? "";
      if (!text.startsWith("__")) {
        prReviews.set(JSON.parse(text));
      }
    } catch { /* empty */ }
  }
}
