/**
 * Codebase Graph — Compliance Overlay and Node Building
 *
 * Extracted from codebase-graph.ts: compliance data overlay construction,
 * individual GraphNode building, and insight folding helpers.
 */

import type { CodebaseInsights } from "@graph/insights.ts";
import { classifyMdNode } from "@graph/md-relations.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import type { GraphNode } from "./codebase-graph.ts";
import { FALLBACK_LAYER_COLOR } from "./codebase-graph-edges.ts";

/** Per-file compliance overlay data. */
export type ComplianceOverlay = {
  fileViolations: Map<string, Map<string, number>>;
  fileVerdicts: Map<string, { timestamp: string; verdict: string }>;
};

/** Update file verdicts map from a single review. */
export function updateFileVerdicts(
  review: { files: string[]; timestamp: string; verdict: string },
  fileVerdicts: Map<string, { timestamp: string; verdict: string }>,
): void {
  for (const file of review.files) {
    const existing = fileVerdicts.get(file);
    if (!existing || review.timestamp > existing.timestamp) {
      fileVerdicts.set(file, { timestamp: review.timestamp, verdict: review.verdict });
    }
  }
}

/** Accumulate violation counts from a single review. */
export function accumulateViolations(
  review: { files: string[]; violations: Array<{ file_path?: string; principle_id: string }> },
  fileViolations: Map<string, Map<string, number>>,
): void {
  for (const v of review.violations) {
    const targetFile = v.file_path || review.files[0];
    if (!targetFile) continue;
    if (!fileViolations.has(targetFile)) fileViolations.set(targetFile, new Map());
    const counts = fileViolations.get(targetFile)!;
    counts.set(v.principle_id, (counts.get(v.principle_id) || 0) + 1);
  }
}

/** Build per-file violation counts and verdicts from reviews. */
export async function buildComplianceOverlay(projectDir: string): Promise<ComplianceOverlay> {
  const store = new DriftStore(projectDir);
  const reviews = await store.getReviews();
  const fileViolations = new Map<string, Map<string, number>>();
  const fileVerdicts = new Map<string, { timestamp: string; verdict: string }>();

  for (const review of reviews) {
    updateFileVerdicts(review, fileVerdicts);
    accumulateViolations(review, fileViolations);
  }

  return { fileVerdicts, fileViolations };
}

/** Options for building a single GraphNode. */
export type BuildGraphNodeOptions = {
  layerColors: Record<string, string>;
  changedSet: Set<string>;
  overlay: ComplianceOverlay;
};

/** Build a single GraphNode from a file path and compliance data. */
export function buildGraphNode(
  filePath: string,
  layer: string,
  options: BuildGraphNodeOptions,
): GraphNode {
  const { layerColors, changedSet, overlay } = options;
  const violations = overlay.fileViolations.get(filePath);
  const violationCount = violations
    ? Array.from(violations.values()).reduce((a, b) => a + b, 0)
    : 0;
  const topViolations = violations
    ? Array.from(violations.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id)
    : [];

  const node: GraphNode = {
    changed: changedSet.has(filePath),
    color: layerColors[layer] || FALLBACK_LAYER_COLOR,
    compliance_score: null,
    extension: filePath.split(".").pop() || "",
    id: filePath,
    last_verdict: overlay.fileVerdicts.get(filePath)?.verdict || null,
    layer,
    top_violations: topViolations,
    violation_count: violationCount,
  };
  const kind = classifyMdNode(filePath);
  if (kind) node.kind = kind;
  return node;
}

/** Options for building graph nodes. */
export type BuildNodesOptions = {
  inferLayer: (filePath: string) => string;
  layerColors: Record<string, string>;
  changedSet: Set<string>;
};

/** Build graph nodes from file paths, enriched with compliance data. */
export async function buildNodes(
  filePaths: string[],
  projectDir: string,
  options: BuildNodesOptions,
): Promise<{ nodes: GraphNode[]; layerCounts: Map<string, number> }> {
  const { inferLayer, layerColors, changedSet } = options;
  const overlay = await buildComplianceOverlay(projectDir);
  const nodes: GraphNode[] = [];
  const layerCounts = new Map<string, number>();

  for (const filePath of filePaths) {
    const layer = inferLayer(filePath) || "unknown";
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
    nodes.push(buildGraphNode(filePath, layer, { changedSet, layerColors, overlay }));
  }

  return { layerCounts, nodes };
}

type StructuralPrincipleIds = {
  layerBoundary: string;
  circularDep: string;
};

/** Build a map of source file -> layer violation count from insights. */
export function buildLayerViolationMap(insights: CodebaseInsights): Map<string, number> {
  const map = new Map<string, number>();
  for (const lv of insights.layer_violations) {
    map.set(lv.source, (map.get(lv.source) || 0) + 1);
  }
  return map;
}

/** Build a set of all nodes that participate in circular dependencies. */
export function buildCycleMemberSet(insights: CodebaseInsights): Set<string> {
  const set = new Set<string>();
  for (const cycle of insights.circular_dependencies) {
    for (const node of cycle) set.add(node);
  }
  return set;
}

/** Fold structural violations (layer crossings, cycles) into node violation counts. */
export function enrichNodesWithInsights(
  nodes: GraphNode[],
  insights: CodebaseInsights,
  principleIds: StructuralPrincipleIds,
): void {
  const layerViolationsBySource = buildLayerViolationMap(insights);
  const cycleMembers = buildCycleMemberSet(insights);

  for (const node of nodes) {
    const lvCount = layerViolationsBySource.get(node.id) || 0;
    if (lvCount > 0) {
      node.violation_count += lvCount;
      if (!node.top_violations.includes(principleIds.layerBoundary)) {
        node.top_violations.push(principleIds.layerBoundary);
      }
    }
    if (cycleMembers.has(node.id)) {
      node.violation_count += 1;
      if (!node.top_violations.includes(principleIds.circularDep)) {
        node.top_violations.push(principleIds.circularDep);
      }
    }
  }
}
