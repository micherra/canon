/** Canon Dashboard Deployment — generates a self-contained HTML dashboard with embedded data */

import { readFile, writeFile, mkdir, stat, readdir } from "fs/promises";
import { join, dirname } from "path";
import { codebaseGraph } from "./codebase-graph.js";
import { loadSummariesFile, flattenSummaries } from "./store-summaries.js";

interface DeployDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  message: string;
  unsummarized_files: string[];
}

// --- Data loading helpers ---

async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function isFileNewerThan(filePath: string, timestamp: string): Promise<boolean> {
  if (!timestamp) return true;
  try {
    const info = await stat(filePath);
    return info.mtime.toISOString() > timestamp;
  } catch {
    return false;
  }
}

// --- Graph generation ---

async function generateGraphData(
  projectDir: string,
  pluginDir: string,
  canonDir: string,
): Promise<{ graphData: Record<string, unknown> | null; error: string | null }> {
  try {
    const freshGraph = await codebaseGraph({}, projectDir, pluginDir);
    const graphData = freshGraph as unknown as Record<string, unknown>;
    await mkdir(canonDir, { recursive: true });
    await writeFile(join(canonDir, "graph-data.json"), JSON.stringify(freshGraph, null, 2), "utf-8");
    return { graphData, error: null };
  } catch (err) {
    const graphData = await readJsonOrNull(join(canonDir, "graph-data.json")) as Record<string, unknown> | null;
    return { graphData, error: String(err) };
  }
}

// --- Summary staleness detection ---

async function findUnsummarizedFiles(
  graphData: Record<string, unknown> | null,
  summaryEntries: Record<string, { summary: string; updated_at: string }>,
  projectDir: string,
): Promise<string[]> {
  const unsummarized: string[] = [];
  if (!graphData || !Array.isArray(graphData.nodes)) return unsummarized;

  for (const node of graphData.nodes as Array<Record<string, unknown>>) {
    const id = node.id as string;
    const entry = summaryEntries[id];
    if (!entry) {
      unsummarized.push(id);
    } else {
      const stale = await isFileNewerThan(join(projectDir, id), entry.updated_at);
      if (stale) unsummarized.push(id);
    }
  }
  return unsummarized;
}

// --- Summary merging ---

function mergeSummariesIntoGraph(
  graphData: Record<string, unknown>,
  summaries: Record<string, string>,
): void {
  if (!Array.isArray(graphData.nodes)) return;
  for (const node of graphData.nodes as Array<Record<string, unknown>>) {
    const id = node.id as string;
    if (summaries[id]) node.summary = summaries[id];
  }
}

// --- PR review collection ---

async function collectPrReviews(canonDir: string): Promise<Record<string, unknown>> {
  const prReviews: Record<string, unknown> = {};
  try {
    const prDir = join(canonDir, "pr-reviews");
    const entries = await readdir(prDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const reviewData = await readJsonOrNull(join(prDir, entry.name, "review-data.json"));
        if (reviewData) prReviews[entry.name] = reviewData;
      }
    }
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) throw err;
  }
  return prReviews;
}

// --- Main entry point ---

export async function deployDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<DeployDashboardOutput> {
  const templatePath = join(pluginDir, ".canon", "dashboard-template.html");
  const outputPath = join(projectDir, ".canon", "dashboard.html");
  const canonDir = join(projectDir, ".canon");

  // Read template
  let template: string;
  try {
    template = await readFile(templatePath, "utf-8");
  } catch (err) {
    return {
      deployed: false,
      dashboard_path: outputPath,
      message: `Failed to read dashboard template: ${err}`,
      unsummarized_files: [],
    };
  }

  // Generate graph data
  const { graphData, error: graphError } = await generateGraphData(projectDir, pluginDir, canonDir);

  // Load and merge summaries
  const summaryEntries = await loadSummariesFile(projectDir);
  const summaries = flattenSummaries(summaryEntries);
  const unsummarizedFiles = await findUnsummarizedFiles(graphData, summaryEntries, projectDir);
  if (graphData) mergeSummariesIntoGraph(graphData, summaries);

  // Collect PR reviews
  const prReviews = await collectPrReviews(canonDir);

  // Inject data into template and write
  const html = template
    .replace("__CANON_GRAPH_DATA__", JSON.stringify(graphData))
    .replace("__CANON_PR_REVIEWS__", JSON.stringify(prReviews));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  // Build status message
  const nodeCount = Array.isArray(graphData?.nodes) ? (graphData.nodes as unknown[]).length : 0;
  const edgeCount = Array.isArray(graphData?.edges) ? (graphData.edges as unknown[]).length : 0;

  const parts: string[] = [
    `Dashboard deployed to ${outputPath} — open directly in any browser (no server needed).`,
    `Graph: ${nodeCount} nodes, ${edgeCount} edges.`,
  ];
  if (graphError) parts.push(`Graph generation error (used cached data): ${graphError}`);
  if (unsummarizedFiles.length > 0) parts.push(`${unsummarizedFiles.length} files need summaries — read each file and call store_summaries to enrich the dashboard.`);

  return {
    deployed: true,
    dashboard_path: outputPath,
    message: parts.join(" "),
    unsummarized_files: unsummarizedFiles,
  };
}
