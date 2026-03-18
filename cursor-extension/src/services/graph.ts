import { readFile } from "fs/promises";
import { join } from "path";

export interface GraphNode {
  id: string;
  layer: string;
  violation_count: number;
  summary?: string;
  exports?: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
