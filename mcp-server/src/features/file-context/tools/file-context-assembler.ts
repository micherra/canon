/** Output assembly helpers for the get_file_context tool. */

import type {
  CoChangePartner,
  HotspotScoreOutput,
} from "@features/knowledge-graph/git-intel/git-intel-types.ts";
import type { UnifiedBlastRadiusReport } from "@graph/kg-blast-radius.ts";
import type {
  FileContextOutput,
  FileEntitySummary,
  FileGraphMetrics,
  FileViolationDetail,
} from "./get-file-context.ts";

/** Group paths by their inferred layer. */
export function groupByLayer(
  paths: string[],
  inferLayer: (p: string) => string,
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const p of paths) {
    const layer = inferLayer(p) || "unknown";
    if (!groups[layer]) groups[layer] = [];
    groups[layer].push(p);
  }
  return groups;
}

/** Derive a human-readable shape characterization from graph metrics. */
export function deriveShape(metrics: FileGraphMetrics | undefined): {
  label: string;
  description: string;
} {
  if (!metrics) {
    return { description: "Moderate connectivity, typical file.", label: "Internal" };
  }

  const { in_degree, out_degree, in_cycle } = metrics;

  let label = "Internal";
  let description = "Moderate connectivity, typical file.";

  if (in_degree > 8 && out_degree < 4) {
    label = "Sink";
    description = "Many things depend on this, it depends on few. Wide blast radius.";
  } else if (in_degree < 3 && out_degree > 8) {
    label = "High fan-out hub";
    description = "Depends on many, depended on by few. Changes propagate outward.";
  } else if (in_degree > 5 && out_degree > 5) {
    label = "Central hub";
    description = "High connectivity in both directions. Highest-risk change surface.";
  } else if (in_degree === 0) {
    label = "Leaf";
    description = "Nothing depends on this. Safe to change.";
  }

  return {
    description,
    label: in_cycle ? `Cycle member — ${label}` : label,
  };
}

/** Derive a human-readable role from graph metrics. */
export function deriveRole(metrics: FileGraphMetrics | undefined): string {
  if (!metrics) return "internal";
  if (metrics.is_hub) return "hub";
  if (metrics.in_cycle) return "cycle member";
  if (metrics.in_degree === 0) return "entry point";
  if (metrics.out_degree === 0) return "leaf";
  return "internal";
}

/** KG data shape used to assemble the output. */
export type KgDataShape = {
  graph_metrics?: FileGraphMetrics;
  project_max_impact: number;
  entities?: FileEntitySummary[];
  blast_radius?: UnifiedBlastRadiusReport;
  summary: string | null;
  imported_by: string[];
  hotspot_score?: HotspotScoreOutput;
  co_change_partners?: Array<CoChangePartner>;
  computed_tags?: string[];
};

/** Compliance data shape from DriftStore. */
export type ComplianceData = {
  violation_count: number;
  last_verdict: string | null;
  violations: FileViolationDetail[];
};

/** Assemble the FileContextOutput from all resolved sub-data. */
export function buildFileContextOutput(params: {
  filePath: string;
  layer: string;
  content: string;
  exports: string[];
  imports: string[];
  imported_by: string[];
  compliance: ComplianceData;
  kgData: KgDataShape;
  layerStack: string[];
  inferLayer: (p: string) => string;
}): FileContextOutput {
  const {
    filePath,
    layer,
    content,
    exports,
    imports,
    imported_by,
    compliance,
    kgData,
    layerStack,
    inferLayer,
  } = params;
  return {
    content,
    exports,
    file_path: filePath,
    imported_by,
    imports,
    layer,
    ...compliance,
    graph_metrics: kgData.graph_metrics,
    imported_by_layer: groupByLayer(imported_by, inferLayer),
    imports_by_layer: groupByLayer(imports, inferLayer),
    layer_stack: layerStack,
    project_max_impact: kgData.project_max_impact,
    role: deriveRole(kgData.graph_metrics),
    shape: deriveShape(kgData.graph_metrics),
    summary: kgData.summary,
    ...(kgData.entities !== undefined && { entities: kgData.entities }),
    ...(kgData.blast_radius !== undefined && { blast_radius: kgData.blast_radius }),
    ...(kgData.hotspot_score !== undefined && { hotspot_score: kgData.hotspot_score }),
    ...(kgData.co_change_partners !== undefined && {
      co_change_partners: kgData.co_change_partners,
    }),
    ...(kgData.computed_tags !== undefined && { computed_tags: kgData.computed_tags }),
  };
}
