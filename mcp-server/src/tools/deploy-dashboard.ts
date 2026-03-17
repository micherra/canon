/** Canon Dashboard Deployment — generates a self-contained HTML dashboard with embedded data */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { codebaseGraph } from "./codebase-graph.js";
import { loadSummariesFile, flattenSummaries } from "./store-summaries.js";

interface DeployDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  message: string;
  unsummarized_files: string[];
}

async function readJsonSafe(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Check if a file has been modified after the given ISO timestamp */
async function isFileNewerThan(filePath: string, timestamp: string): Promise<boolean> {
  if (!timestamp) return true;
  try {
    const info = await stat(filePath);
    return info.mtime.toISOString() > timestamp;
  } catch {
    return false;
  }
}

export async function deployDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<DeployDashboardOutput> {
  const templatePath = join(pluginDir, ".canon", "dashboard-template.html");
  const outputPath = join(projectDir, ".canon", "dashboard.html");

  // Read the template
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

  // Generate fresh graph data by running the codebase graph scanner
  const canonDir = join(projectDir, ".canon");
  let graphData: Record<string, unknown> | null = null;
  try {
    const freshGraph = await codebaseGraph({}, projectDir, pluginDir);
    graphData = freshGraph as unknown as Record<string, unknown>;
    // Persist so other tools (ask_codebase) can also use fresh data
    await mkdir(canonDir, { recursive: true });
    await writeFile(join(canonDir, "graph-data.json"), JSON.stringify(freshGraph, null, 2), "utf-8");
  } catch {
    // Fall back to cached graph data on disk
    graphData = await readJsonSafe(join(canonDir, "graph-data.json")) as Record<string, unknown> | null;
  }

  const summaryEntries = await loadSummariesFile(projectDir);
  const summaries = flattenSummaries(summaryEntries);

  // Identify files that need summaries: missing or stale (file modified since last summary)
  const unsummarizedFiles: string[] = [];
  if (graphData && Array.isArray(graphData.nodes)) {
    for (const node of graphData.nodes as Array<Record<string, unknown>>) {
      const id = node.id as string;
      const entry = summaryEntries[id];
      if (!entry) {
        unsummarizedFiles.push(id);
      } else {
        const stale = await isFileNewerThan(join(projectDir, id), entry.updated_at);
        if (stale) {
          unsummarizedFiles.push(id);
        }
      }
    }
  }

  // Merge summaries into graph nodes
  if (graphData && Array.isArray(graphData.nodes)) {
    for (const node of graphData.nodes as Array<Record<string, unknown>>) {
      const id = node.id as string;
      if (summaries[id]) {
        node.summary = summaries[id];
      }
    }
  }

  // Gather PR review data (collect all available reviews into a map)
  const prReviews: Record<string, unknown> = {};
  try {
    const { readdir } = await import("fs/promises");
    const prDir = join(canonDir, "pr-reviews");
    const entries = await readdir(prDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const reviewData = await readJsonSafe(
          join(prDir, entry.name, "review-data.json"),
        );
        if (reviewData) {
          prReviews[entry.name] = reviewData;
        }
      }
    }
  } catch {
    // pr-reviews dir may not exist yet
  }

  // Inject data into template by replacing placeholder strings
  const html = template
    .replace("__CANON_GRAPH_DATA__", JSON.stringify(graphData))
    .replace("__CANON_PR_REVIEWS__", JSON.stringify(prReviews));

  // Write the self-contained HTML
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  const summaryNote = unsummarizedFiles.length > 0
    ? ` ${unsummarizedFiles.length} files need summaries — read each file and call store_summaries to enrich the dashboard.`
    : "";

  return {
    deployed: true,
    dashboard_path: outputPath,
    message: `Dashboard deployed to ${outputPath} — open directly in any browser (no server needed).${summaryNote}`,
    unsummarized_files: unsummarizedFiles,
  };
}
