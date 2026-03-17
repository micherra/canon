/** Ask codebase — returns structured graph analysis with human-readable answers */

import { readFile } from "fs/promises";
import { join } from "path";
import { generateInsights } from "../graph/insights.js";
import { loadSummariesFile, flattenSummaries } from "./store-summaries.js";

export interface AskCodebaseInput {
  question: string;
  file_path?: string;
  layer?: string;
}

export interface AskCodebaseOutput {
  focus: string;
  answer: string;
  data: Record<string, unknown>;
  relevant_files: string[];
}

interface GraphData {
  nodes: Array<{ id: string; layer: string; violation_count: number; last_verdict: string | null }>;
  edges: Array<{ source: string; target: string }>;
  insights?: Record<string, unknown>;
}

// --- Data loading ---

async function loadGraphData(projectDir: string): Promise<GraphData | null> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "graph-data.json"), "utf-8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadSummaries(projectDir: string): Promise<Record<string, string>> {
  const entries = await loadSummariesFile(projectDir);
  return flattenSummaries(entries);
}

// --- Question routing ---

function detectFocus(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("circular") || q.includes("cycle")) return "cycles";
  if (q.includes("depend") || q.includes("import") || q.includes("who uses") || q.includes("what uses")) return "dependencies";
  if (q.includes("orphan") || q.includes("unused") || q.includes("dead")) return "orphans";
  if (q.includes("hotspot") || q.includes("violation")) return "violations";
  if (q.includes("connected") || q.includes("hub") || q.includes("central")) return "most_connected";
  if (q.includes("layer")) return "layers";
  if (q.includes("summary") || q.includes("what does") || q.includes("explain") || q.includes("role")) return "file_summary";
  return "search";
}

// --- File matching ---

function findMentionedFile(
  question: string,
  nodes: Array<{ id: string }>,
): string | null {
  for (const node of nodes) {
    if (question.includes(node.id)) return node.id;
  }
  for (const node of nodes) {
    const name = node.id.split("/").pop() || "";
    if (name && question.includes(name)) return node.id;
  }
  const q = question.toLowerCase();
  for (const node of nodes) {
    const name = (node.id.split("/").pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
    if (name && name.length > 3 && q.includes(name)) return node.id;
  }
  return null;
}

function searchByKeywords(
  question: string,
  nodes: GraphData["nodes"],
  summaries: Record<string, string>,
): Array<{ node: GraphData["nodes"][0]; score: number }> {
  const stopWords = new Set(["the", "and", "for", "are", "what", "how", "does", "which", "that", "this", "with", "from", "have", "has", "used", "use", "where", "who"]);
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  if (keywords.length === 0) return [];

  return nodes.map(n => {
    const id = n.id.toLowerCase();
    const summary = (summaries[n.id] || "").toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (id.includes(kw)) score += 2;
      if (summary.includes(kw)) score += 1;
    }
    return { node: n, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
}

// --- Answer formatting ---

const basename = (p: string) => p.split("/").pop() || p;

function formatFileDetail(
  fp: string,
  graph: GraphData,
  summaries: Record<string, string>,
  inEdges: Map<string, string[]>,
  outEdges: Map<string, string[]>,
): AskCodebaseOutput {
  const node = graph.nodes.find((n) => n.id === fp);
  const imports = outEdges.get(fp) || [];
  const importedBy = inEdges.get(fp) || [];
  const summary = summaries[fp];
  const lines: string[] = [];
  lines.push(`**${fp}** (${node?.layer || "unknown"} layer)`);
  if (summary) lines.push(summary);
  if (imports.length > 0) lines.push(`**Imports** (${imports.length}): ${imports.map(basename).join(", ")}`);
  if (importedBy.length > 0) lines.push(`**Imported by** (${importedBy.length}): ${importedBy.map(basename).join(", ")}`);
  if ((node?.violation_count || 0) > 0) lines.push(`**Violations:** ${node!.violation_count} (verdict: ${node!.last_verdict || "unknown"})`);
  else lines.push("No violations.");
  return {
    focus: "file_detail",
    answer: lines.join("\n\n"),
    data: { file: fp, layer: node?.layer, imports, imported_by: importedBy, violation_count: node?.violation_count || 0, summary },
    relevant_files: [fp, ...imports, ...importedBy],
  };
}

function formatCycles(cycles: string[][]): AskCodebaseOutput {
  const answer = cycles.length === 0
    ? "No circular dependencies found in the codebase."
    : `Found **${cycles.length}** circular dependenc${cycles.length === 1 ? "y" : "ies"}:\n\n` +
      cycles.map((c, i) => `${i + 1}. ${c.map(basename).join(" → ")} → ${basename(c[0])}`).join("\n");
  return { focus: "cycles", answer, data: { circular_dependencies: cycles, count: cycles.length }, relevant_files: cycles.flat() };
}

function formatMostConnected(top: Array<{ path: string; in_degree: number; out_degree: number; total: number }>, label: string): AskCodebaseOutput {
  const answer = `**${label}:**\n\n` +
    top.map((n, i) => `${i + 1}. **${basename(n.path)}** — ${n.in_degree} in, ${n.out_degree} out (${n.total} total)`).join("\n");
  return { focus: "most_connected", answer, data: { most_connected: top }, relevant_files: top.map(n => n.path) };
}

function formatOrphans(orphans: string[]): AskCodebaseOutput {
  const answer = orphans.length === 0
    ? "No orphan files — every file is connected to the dependency graph."
    : `Found **${orphans.length}** orphan file${orphans.length === 1 ? "" : "s"} (no imports or importers):\n\n` +
      orphans.map(f => `- ${basename(f)}`).join("\n");
  return { focus: "orphans", answer, data: { orphan_files: orphans, count: orphans.length }, relevant_files: orphans };
}

function formatViolations(
  layerViolations: Array<{ source: string; target: string; source_layer: string; target_layer: string }>,
  hotspots: GraphData["nodes"],
): AskCodebaseOutput {
  const lines: string[] = [];
  if (layerViolations.length > 0) {
    lines.push(`**${layerViolations.length} layer violation${layerViolations.length === 1 ? "" : "s"}:**\n`);
    layerViolations.slice(0, 8).forEach(v => lines.push(`- ${basename(v.source)} (${v.source_layer}) → ${basename(v.target)} (${v.target_layer})`));
    if (layerViolations.length > 8) lines.push(`- ...and ${layerViolations.length - 8} more`);
  }
  if (hotspots.length > 0) {
    lines.push(`\n**Hotspot files** (most violations):\n`);
    hotspots.forEach(n => lines.push(`- **${basename(n.id)}** — ${n.violation_count} violations (${n.last_verdict || "no verdict"})`));
  }
  if (lines.length === 0) lines.push("No violations found.");
  return {
    focus: "violations", answer: lines.join("\n"), data: { layer_violations: layerViolations, hotspot_files: hotspots },
    relevant_files: [...layerViolations.map(v => v.source), ...hotspots.map(n => n.id)],
  };
}

function formatLayers(graph: GraphData, layerViolationCount: number): AskCodebaseOutput {
  const layerBreakdown = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (!layerBreakdown.has(n.layer)) layerBreakdown.set(n.layer, []);
    layerBreakdown.get(n.layer)!.push(n.id);
  }
  const lines = ["**Codebase layers:**\n"];
  for (const [layer, files] of layerBreakdown) {
    lines.push(`- **${layer}**: ${files.length} files`);
  }
  if (layerViolationCount > 0) {
    lines.push(`\n${layerViolationCount} layer violation${layerViolationCount === 1 ? "" : "s"} found.`);
  }
  return {
    focus: "layers", answer: lines.join("\n"), data: { layers: Object.fromEntries(layerBreakdown) },
    relevant_files: graph.nodes.map(n => n.id),
  };
}

function formatSearchResults(
  scored: Array<{ node: GraphData["nodes"][0]; score: number }>,
  summaries: Record<string, string>,
): AskCodebaseOutput {
  const lines = [`Found **${scored.length}** relevant file${scored.length === 1 ? "" : "s"}:\n`];
  for (const { node: n } of scored) {
    const summary = summaries[n.id];
    lines.push(`- **${basename(n.id)}** (${n.layer})${summary ? " — " + summary : ""}`);
  }
  return {
    focus: "search",
    answer: lines.join("\n"),
    data: { matches: scored.map(s => ({ path: s.node.id, layer: s.node.layer, summary: summaries[s.node.id] || null })) },
    relevant_files: scored.map(s => s.node.id),
  };
}

function formatOverview(
  insights: ReturnType<typeof generateInsights>,
  summaryCount: number,
): AskCodebaseOutput {
  const ov = insights.overview;
  const top = insights.most_connected.slice(0, 5);
  const lines = [
    `**Codebase overview:** ${ov.total_files} files, ${ov.total_edges} edges\n`,
    "**Layers:** " + (ov.layers || []).map((l: { name: string; file_count: number }) => `${l.name} (${l.file_count})`).join(", "),
    "\n**Most connected:** " + top.map(n => `${basename(n.path)} (${n.total})`).join(", "),
  ];
  const issues: string[] = [];
  if (insights.circular_dependencies.length > 0) issues.push(`${insights.circular_dependencies.length} cycles`);
  if (insights.layer_violations.length > 0) issues.push(`${insights.layer_violations.length} layer violations`);
  if (insights.orphan_files.length > 0) issues.push(`${insights.orphan_files.length} orphans`);
  if (issues.length > 0) lines.push("\n**Issues:** " + issues.join(", "));
  lines.push(`\n${summaryCount} file summaries available.`);
  lines.push("\nTry asking about a specific file, layer, cycles, violations, or dependencies.");
  return {
    focus: "overview",
    answer: lines.join("\n"),
    data: { overview: ov, most_connected: top },
    relevant_files: top.map(n => n.path),
  };
}

// --- Main entry point ---

export async function askCodebase(
  input: AskCodebaseInput,
  projectDir: string,
): Promise<AskCodebaseOutput> {
  const graph = await loadGraphData(projectDir);
  const summaries = await loadSummaries(projectDir);

  if (!graph) {
    return {
      focus: "error",
      answer: "No graph data found. Run `/canon:dashboard` first to generate the codebase graph.",
      data: {},
      relevant_files: [],
    };
  }

  const focus = input.file_path ? "file_detail" : detectFocus(input.question);
  const insights = generateInsights(graph.nodes, graph.edges);

  // Build adjacency info
  const inEdges = new Map<string, string[]>();
  const outEdges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!outEdges.has(edge.source)) outEdges.set(edge.source, []);
    outEdges.get(edge.source)!.push(edge.target);
    if (!inEdges.has(edge.target)) inEdges.set(edge.target, []);
    inEdges.get(edge.target)!.push(edge.source);
  }

  const fileDetail = (fp: string) => formatFileDetail(fp, graph, summaries, inEdges, outEdges);

  switch (focus) {
    case "file_detail":
      return fileDetail(input.file_path!);

    case "cycles":
      return formatCycles(insights.circular_dependencies);

    case "dependencies": {
      const mentionedFile = findMentionedFile(input.question, graph.nodes);
      if (mentionedFile) return fileDetail(mentionedFile);
      return formatMostConnected(insights.most_connected.slice(0, 8), "Most connected files (highest total dependencies)");
    }

    case "orphans":
      return formatOrphans(insights.orphan_files);

    case "violations": {
      const hotspots = graph.nodes.filter(n => n.violation_count > 0).sort((a, b) => b.violation_count - a.violation_count).slice(0, 10);
      return formatViolations(insights.layer_violations, hotspots);
    }

    case "most_connected":
      return formatMostConnected(insights.most_connected.slice(0, 8), "Most connected files");

    case "layers":
      return formatLayers(graph, insights.layer_violations.length);

    case "file_summary": {
      const mentionedFile = findMentionedFile(input.question, graph.nodes);
      if (mentionedFile) {
        const summary = summaries[mentionedFile];
        const layer = graph.nodes.find(n => n.id === mentionedFile)?.layer || "unknown";
        const answer = summary
          ? `**${mentionedFile}** (${layer})\n\n${summary}`
          : `**${mentionedFile}** (${layer})\n\nNo summary available yet. Run \`/canon:dashboard\` to generate summaries.`;
        return { focus: "file_summary", answer, data: { file: mentionedFile, summary, layer }, relevant_files: [mentionedFile] };
      }
      const total = Object.keys(summaries).length;
      return {
        focus: "file_summary",
        answer: `**${total}** file summaries available. Mention a specific file to see its summary.`,
        data: { total },
        relevant_files: [],
      };
    }

    default: {
      const mentionedFile = findMentionedFile(input.question, graph.nodes);
      if (mentionedFile) return fileDetail(mentionedFile);

      const scored = searchByKeywords(input.question, graph.nodes, summaries);
      if (scored.length > 0) return formatSearchResults(scored, summaries);

      return formatOverview(insights, Object.keys(summaries).length);
    }
  }
}
