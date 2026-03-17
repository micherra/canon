/** Ask codebase — returns structured graph analysis for Claude to reason about */

import { readFile } from "fs/promises";
import { join } from "path";
import { generateInsights } from "../graph/insights.js";

export interface AskCodebaseInput {
  question: string;
  file_path?: string;
  layer?: string;
}

export interface AskCodebaseOutput {
  focus: string;
  data: Record<string, unknown>;
  relevant_files: string[];
}

interface GraphData {
  nodes: Array<{ id: string; layer: string; violation_count: number; last_verdict: string | null }>;
  edges: Array<{ source: string; target: string }>;
  insights?: Record<string, unknown>;
}

async function loadGraphData(projectDir: string): Promise<GraphData | null> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "graph-data.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSummaries(projectDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "summaries.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Route the question to the right analysis */
function detectFocus(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("circular") || q.includes("cycle")) return "cycles";
  if (q.includes("depend") || q.includes("import") || q.includes("who uses") || q.includes("what uses")) return "dependencies";
  if (q.includes("orphan") || q.includes("unused") || q.includes("dead")) return "orphans";
  if (q.includes("hotspot") || q.includes("violation")) return "violations";
  if (q.includes("connected") || q.includes("hub") || q.includes("central")) return "most_connected";
  if (q.includes("layer")) return "layers";
  if (q.includes("summary") || q.includes("what does") || q.includes("explain") || q.includes("role")) return "file_summary";
  return "overview";
}

export async function askCodebase(
  input: AskCodebaseInput,
  projectDir: string,
): Promise<AskCodebaseOutput> {
  const graph = await loadGraphData(projectDir);
  const summaries = await loadSummaries(projectDir);

  if (!graph) {
    return {
      focus: "error",
      data: { message: "No graph data found. Run codebase_graph first to generate the graph." },
      relevant_files: [],
    };
  }

  const focus = input.file_path ? "file_detail" : detectFocus(input.question);
  const insights = generateInsights(graph.nodes, graph.edges);

  // Build adjacency info for file-specific queries
  const inEdges = new Map<string, string[]>();
  const outEdges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!outEdges.has(edge.source)) outEdges.set(edge.source, []);
    outEdges.get(edge.source)!.push(edge.target);
    if (!inEdges.has(edge.target)) inEdges.set(edge.target, []);
    inEdges.get(edge.target)!.push(edge.source);
  }

  switch (focus) {
    case "file_detail": {
      const fp = input.file_path!;
      const node = graph.nodes.find((n) => n.id === fp);
      return {
        focus: "file_detail",
        data: {
          file: fp,
          layer: node?.layer || "unknown",
          imports: outEdges.get(fp) || [],
          imported_by: inEdges.get(fp) || [],
          violation_count: node?.violation_count || 0,
          last_verdict: node?.last_verdict || null,
          summary: summaries[fp] || null,
        },
        relevant_files: [fp, ...(outEdges.get(fp) || []), ...(inEdges.get(fp) || [])],
      };
    }

    case "cycles":
      return {
        focus: "cycles",
        data: {
          circular_dependencies: insights.circular_dependencies,
          count: insights.circular_dependencies.length,
        },
        relevant_files: insights.circular_dependencies.flat(),
      };

    case "dependencies": {
      // If a file is mentioned in the question, focus on it
      const mentionedFile = findMentionedFile(input.question, graph.nodes);
      if (mentionedFile) {
        return {
          focus: "dependencies",
          data: {
            file: mentionedFile,
            imports: outEdges.get(mentionedFile) || [],
            imported_by: inEdges.get(mentionedFile) || [],
            summary: summaries[mentionedFile] || null,
          },
          relevant_files: [mentionedFile, ...(outEdges.get(mentionedFile) || []), ...(inEdges.get(mentionedFile) || [])],
        };
      }
      return {
        focus: "dependencies",
        data: { most_connected: insights.most_connected },
        relevant_files: insights.most_connected.map((n) => n.path),
      };
    }

    case "orphans":
      return {
        focus: "orphans",
        data: {
          orphan_files: insights.orphan_files,
          count: insights.orphan_files.length,
        },
        relevant_files: insights.orphan_files,
      };

    case "violations":
      return {
        focus: "violations",
        data: {
          layer_violations: insights.layer_violations,
          hotspot_files: graph.nodes
            .filter((n) => n.violation_count > 0)
            .sort((a, b) => b.violation_count - a.violation_count)
            .slice(0, 10)
            .map((n) => ({ path: n.id, violations: n.violation_count, verdict: n.last_verdict })),
        },
        relevant_files: [
          ...insights.layer_violations.map((v) => v.source),
          ...graph.nodes.filter((n) => n.violation_count > 0).map((n) => n.id),
        ],
      };

    case "most_connected":
      return {
        focus: "most_connected",
        data: { most_connected: insights.most_connected },
        relevant_files: insights.most_connected.map((n) => n.path),
      };

    case "layers": {
      const layerFilter = input.layer;
      const layerNodes = layerFilter
        ? graph.nodes.filter((n) => n.layer === layerFilter)
        : graph.nodes;
      const layerBreakdown = new Map<string, string[]>();
      for (const n of layerNodes) {
        if (!layerBreakdown.has(n.layer)) layerBreakdown.set(n.layer, []);
        layerBreakdown.get(n.layer)!.push(n.id);
      }
      return {
        focus: "layers",
        data: {
          layers: Object.fromEntries(layerBreakdown),
          layer_violations: insights.layer_violations,
        },
        relevant_files: layerNodes.map((n) => n.id),
      };
    }

    case "file_summary": {
      const mentionedFile = findMentionedFile(input.question, graph.nodes);
      if (mentionedFile) {
        return {
          focus: "file_summary",
          data: {
            file: mentionedFile,
            summary: summaries[mentionedFile] || "No summary available. Run /canon:dashboard to generate.",
            layer: graph.nodes.find((n) => n.id === mentionedFile)?.layer || "unknown",
          },
          relevant_files: [mentionedFile],
        };
      }
      // Return all summaries
      return {
        focus: "file_summary",
        data: {
          summaries,
          total: Object.keys(summaries).length,
        },
        relevant_files: Object.keys(summaries),
      };
    }

    default:
      return {
        focus: "overview",
        data: {
          overview: insights.overview,
          most_connected: insights.most_connected.slice(0, 5),
          circular_dependencies_count: insights.circular_dependencies.length,
          layer_violations_count: insights.layer_violations.length,
          orphan_count: insights.orphan_files.length,
          summaries_available: Object.keys(summaries).length,
        },
        relevant_files: insights.most_connected.slice(0, 5).map((n) => n.path),
      };
  }
}

/** Try to find a file path mentioned in the question */
function findMentionedFile(
  question: string,
  nodes: Array<{ id: string }>,
): string | null {
  // Try exact path match
  for (const node of nodes) {
    if (question.includes(node.id)) return node.id;
  }
  // Try filename match
  for (const node of nodes) {
    const basename = node.id.split("/").pop() || "";
    if (basename && question.includes(basename)) return node.id;
  }
  return null;
}
