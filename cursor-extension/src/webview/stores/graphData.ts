import { writable, derived } from "svelte/store";

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
  insights?: any;
  principles?: Record<string, PrincipleInfo>;
}

export interface PrReview {
  pr_review_id?: string;
  pr_number?: number;
  verdict: string;
  score: any;
  violations: any[];
  files: string[];
}

export type GraphStatus = "ready" | "generating" | "refreshing" | "error" | "empty";
export const graphData = writable<GraphData | null>(null);
export const graphStatus = writable<GraphStatus>("empty");
export const prReviews = writable<PrReview[] | null>(null);
export const summaryProgress = writable<{ completed: number; total: number } | null>(null);

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

export const layerColors = derived(graphData, ($g) => {
  const map: Record<string, string> = {};
  if (!$g) return map;
  for (const layer of $g.layers || []) {
    if (layer?.name && layer?.color) map[layer.name] = layer.color;
  }
  for (const n of $g.nodes || []) {
    if (n.layer && n.color && !map[n.layer]) map[n.layer] = n.color;
  }
  return map;
});


// Derived insight counts (shared between HealthStrip and InsightsPanel)
export const violationCount = derived(graphData, ($g) => {
  if (!$g) return 0;
  return $g.nodes.reduce((sum, n) => sum + (n.violation_count || 0), 0);
});

export const cycleCount = derived(graphData, ($g) =>
  ($g?.insights?.circular_dependencies || []).length,
);

export const orphanCount = derived(graphData, ($g) =>
  ($g?.insights?.orphan_files || []).length,
);

export const principles = derived(graphData, ($g) =>
  $g?.principles || {},
);

export const entityCount = derived(graphData, ($g) =>
  ($g?.nodes || []).reduce((sum, n) => sum + (n.entity_count || 0), 0)
);

export const deadCodeCount = derived(graphData, ($g) =>
  ($g?.nodes || []).reduce((sum, n) => sum + (n.dead_code_count || 0), 0)
);

export const communityMap = derived(graphData, ($g) => {
  const map = new Map<number, string[]>();
  for (const n of $g?.nodes || []) {
    if (n.community !== undefined) {
      const list = map.get(n.community) || [];
      list.push(n.id);
      map.set(n.community, list);
    }
  }
  return map;
});

/** Read JSON from embedded script tags and populate stores */
export function loadEmbeddedData() {
  // Read graph generation status
  const appEl = document.getElementById("app");
  const status = appEl?.dataset.graphStatus;
  if (status === "generating") {
    graphStatus.set("generating");
  }

  const graphEl = document.getElementById("canon-graph-data");
  if (graphEl) {
    try {
      const text = graphEl.textContent?.trim() ?? "";
      if (!text.startsWith("__")) {
        const data = JSON.parse(text) as GraphData;
        if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
          graphData.set(data);
          graphStatus.set("ready");
        }
      }
    } catch { /* empty */ }
  }

  const prEl = document.getElementById("canon-pr-reviews");
  if (prEl) {
    try {
      const text = prEl.textContent?.trim() ?? "";
      if (!text.startsWith("__")) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          prReviews.set(parsed);
        }
      }
    } catch { /* empty */ }
  }

  // Listen for push messages from extension
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "summaryProgress") {
      if (typeof msg.completed === "number" && typeof msg.total === "number") {
        summaryProgress.set({ completed: msg.completed, total: msg.total });
      }
    } else if (msg.type === "graphData") {
      // Validate at trust boundary — ensure data has expected shape
      const data = msg.data;
      if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
        graphData.set(data as GraphData);
        graphStatus.set("ready");
      }
    } else if (msg.type === "graphStatus") {
      const valid: GraphStatus[] = ["ready", "generating", "refreshing", "error", "empty"];
      if (valid.includes(msg.status)) {
        graphStatus.set(msg.status as GraphStatus);
      }
    } else if (msg.type === "prReviews") {
      if (Array.isArray(msg.data)) {
        prReviews.set(msg.data);
      }
    }
  });
}
