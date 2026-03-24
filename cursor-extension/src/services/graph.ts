import { readFile } from "fs/promises";
import { join } from "path";

export interface GraphNode {
  id: string;
  layer: string;
  violation_count: number;
  changed?: boolean;
  summary?: string;
  exports?: string[];
  // Fields present in actual graph-data.json emitted by view-materializer
  color?: string;
  extension?: string;
  kind?: string;
  top_violations?: string[];
  last_verdict?: string | null;
  compliance_score?: number | null;
  entity_count?: number;
  export_count?: number;
  dead_code_count?: number;
  community?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind?: string;
  type?: "import" | "re-export" | "composition";
  confidence?: number;
  evidence?: string;
  relation?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers?: Array<{ name: string; color: string; file_count: number; index?: number }>;
  principles?: Record<string, { title: string; severity: string; summary: string }>;
  insights?: any;
  generated_at?: string;
}

/** Read the pre-generated graph data and merge in summaries */
export async function readGraphData(workspaceRoot: string): Promise<GraphData> {
  const graphPath = join(workspaceRoot, ".canon", "graph-data.json");
  const raw = await readFile(graphPath, "utf-8");
  const graph = JSON.parse(raw) as GraphData;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("Invalid graph data: missing nodes or edges array");
  }

  // Merge summaries from summaries.json into graph nodes
  try {
    const sumRaw = await readFile(join(workspaceRoot, ".canon", "summaries.json"), "utf-8");
    const summaries = JSON.parse(sumRaw) as Record<string, string | { summary: string }>;
    for (const node of graph.nodes) {
      if (!node.summary) {
        const entry = summaries[node.id];
        if (entry) {
          node.summary = typeof entry === "string" ? entry : entry.summary || "";
        }
      }
    }
  } catch {
    // No summaries file
  }

  return graph;
}
