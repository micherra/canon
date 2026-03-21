/** Returns the currently selected node from the Canon dashboard extension. */

import { readFile } from "fs/promises";
import { join } from "path";
import { getFileContext } from "./get-file-context.js";
import { loadAllPrinciples, matchPrinciples } from "../matcher.js";
import { loadCachedGraph, getNodeMetrics, getDownstreamAffected } from "../graph/query.js";
import { extractSummary } from "../constants.js";

interface ActiveFilePrinciple {
  id: string;
  title: string;
  severity: string;
  summary: string;
}

export interface DashboardGraphMetrics {
  in_degree: number;
  out_degree: number;
  is_hub: boolean;
  in_cycle: boolean;
  impact_score: number;
  downstream_affected: string[];
}

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
  active_file: string | null;
  active_file_principles: ActiveFilePrinciple[];
  graph_metrics?: DashboardGraphMetrics;
}

export async function getDashboardSelection(
  projectDir: string,
  pluginDir: string
): Promise<DashboardSelectionOutput> {
  const statePath = join(projectDir, ".canon", "dashboard-state.json");

  const emptyResult: DashboardSelectionOutput = {
    has_selection: false,
    selected_node_id: null,
    layer: null,
    summary: null,
    violation_count: 0,
    dependencies: [],
    dependents: [],
    file_content_preview: null,
    timestamp: null,
    active_file: null,
    active_file_principles: [],
  };

  try {
    const raw = await readFile(statePath, "utf-8");
    const state = JSON.parse(raw);
    const node = state.selectedNode;
    const activeFile: string | null = state.activeFile || null;

    // Load principles for active file if available
    let activeFilePrinciples: ActiveFilePrinciple[] = [];
    if (activeFile) {
      try {
        const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
        const matched = matchPrinciples(allPrinciples, { file_path: activeFile });
        activeFilePrinciples = matched.slice(0, 3).map((p) => ({
          id: p.id,
          title: p.title,
          severity: p.severity,
          summary: extractSummary(p.body),
        }));
      } catch {
        // Principle loading failed — skip
      }
    }

    if (!node?.id) {
      return {
        ...emptyResult,
        timestamp: state.timestamp || null,
        active_file: activeFile,
        active_file_principles: activeFilePrinciples,
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

    // Load graph metrics for selected node
    let graphMetrics: DashboardGraphMetrics | undefined;
    const graph = await loadCachedGraph(projectDir);
    if (graph) {
      const metrics = getNodeMetrics(graph, node.id);
      if (metrics) {
        graphMetrics = {
          in_degree: metrics.in_degree,
          out_degree: metrics.out_degree,
          is_hub: metrics.is_hub,
          in_cycle: metrics.in_cycle,
          impact_score: metrics.impact_score,
          downstream_affected: getDownstreamAffected(graph, node.id, 2),
        };
      }
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
      active_file: activeFile,
      active_file_principles: activeFilePrinciples,
      graph_metrics: graphMetrics,
    };
  } catch {
    return emptyResult;
  }
}
