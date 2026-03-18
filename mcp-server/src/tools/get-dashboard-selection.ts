/** Returns the currently selected node from the Canon dashboard extension. */

import { readFile } from "fs/promises";
import { join } from "path";
import { getFileContext } from "./get-file-context.js";

export interface DashboardSelectionOutput {
  has_selection: boolean;
  selected_node_id: string | null;
  layer: string | null;
  summary: string | null;
  violation_count: number;
  dependencies: string[];
  dependents: string[];
  file_content_preview: string | null;
  timestamp: string | null;
}

export async function getDashboardSelection(
  projectDir: string
): Promise<DashboardSelectionOutput> {
  const statePath = join(projectDir, ".canon", "dashboard-state.json");

  try {
    const raw = await readFile(statePath, "utf-8");
    const state = JSON.parse(raw);
    const node = state.selectedNode;

    if (!node?.id) {
      return {
        has_selection: false,
        selected_node_id: null,
        layer: null,
        summary: null,
        violation_count: 0,
        dependencies: [],
        dependents: [],
        file_content_preview: null,
        timestamp: state.timestamp || null,
      };
    }

    // Enrich with file context from the graph
    let dependencies: string[] = [];
    let dependents: string[] = [];
    let filePreview: string | null = null;

    try {
      const ctx = await getFileContext({ file_path: node.id }, projectDir);
      dependencies = ctx.imports || [];
      dependents = ctx.imported_by || [];
      if (ctx.content) {
        filePreview = ctx.content.slice(0, 500);
      }
    } catch {
      // File context unavailable
    }

    return {
      has_selection: true,
      selected_node_id: node.id,
      layer: node.layer || null,
      summary: node.summary || null,
      violation_count: node.violation_count || 0,
      dependencies,
      dependents,
      file_content_preview: filePreview,
      timestamp: state.timestamp || null,
    };
  } catch {
    return {
      has_selection: false,
      selected_node_id: null,
      layer: null,
      summary: null,
      violation_count: 0,
      dependencies: [],
      dependents: [],
      file_content_preview: null,
      timestamp: null,
    };
  }
}
