/** Canon Dashboard Deployment — generates a self-contained HTML dashboard with embedded data */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { EventStore } from "../drift/event-store.js";
import { RalphStore } from "../drift/ralph-store.js";

interface DeployDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  message: string;
}

async function readJsonSafe(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readJsonlSafe(path: string): Promise<unknown[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function deployDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<DeployDashboardOutput> {
  const templatePath = join(pluginDir, "ui", "dashboard.html");
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
    };
  }

  // Gather data from .canon/ directory
  const canonDir = join(projectDir, ".canon");
  const graphData = await readJsonSafe(join(canonDir, "graph-data.json"));
  const principlesData = await readJsonSafe(
    join(canonDir, "principles-data.json"),
  );
  const orchestrationData = await readJsonSafe(
    join(canonDir, "orchestration-data.json"),
  );
  const flowData = await readJsonSafe(join(canonDir, "flow-list.json"));

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
    .replace("__CANON_PRINCIPLES_DATA__", JSON.stringify(principlesData))
    .replace(
      "__CANON_ORCHESTRATION_DATA__",
      JSON.stringify(orchestrationData),
    )
    .replace("__CANON_FLOW_DATA__", JSON.stringify(flowData))
    .replace("__CANON_PR_REVIEWS__", JSON.stringify(prReviews));

  // Write the self-contained HTML
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  return {
    deployed: true,
    dashboard_path: outputPath,
    message: `Dashboard deployed to ${outputPath} — open directly in any browser (no server needed).`,
  };
}
