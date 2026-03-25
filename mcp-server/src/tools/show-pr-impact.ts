/**
 * show_pr_impact — Server-side tool handler
 *
 * Assembles a PrImpactOutput by orchestrating multiple data sources:
 *   1. Latest PR review from PrStore
 *   2. Blast radius analysis via analyzeBlastRadius (when KG is available)
 *   3. Subgraph extraction from graph-data.json (filtered to blast radius affected files)
 *   4. Drift decisions cross-referenced with violated principles
 *   5. Risk-ranked hotspot list (blast radius size × severity weight)
 *
 * Graceful degradation:
 *   - No PR review → status: "no_review"
 *   - KG absent → blast radius and subgraph empty, review data still returned
 *   - KG query throws → continues without blast radius (no_kg does not apply here)
 *
 * Canon principles:
 *   - functions-do-one-thing: showPrImpact assembles one payload; helpers handle sub-tasks
 *   - deep-modules: simple (projectDir) → (PrImpactOutput) interface; complexity hidden
 *   - validate-at-trust-boundaries: structured errors/empty states, never throws to caller
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve, isAbsolute } from "path";
import { PrStore } from "../drift/pr-store.ts";
import { DriftStore } from "../drift/store.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import type { PrReviewEntry, ReviewViolation } from "../schema.ts";

/** Resolve a project-relative path safely. Returns null on traversal attempts. */
function safeResolvePath(projectDir: string, filePath: string): string | null {
  if (isAbsolute(filePath)) return null;
  if (filePath.includes("..")) return null;
  const resolved = resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + "/") && resolved !== projectDir) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrImpactHotspot {
  file: string;
  blast_radius_count: number;
  violation_count: number;
  risk_score: number;
  violations: Array<{ principle_id: string; severity: string; message?: string }>;
}

export interface PrImpactSubgraphNode {
  id: string;
  layer: string;
  changed?: boolean;
  violation_count?: number;
}

export interface PrImpactSubgraphEdge {
  source: string;
  target: string;
  confidence?: number;
}

export interface PrImpactSubgraph {
  nodes: PrImpactSubgraphNode[];
  edges: PrImpactSubgraphEdge[];
  layers: Array<{ name: string; color: string; file_count: number }>;
}

export interface PrImpactOutput {
  status: "ok" | "no_review" | "no_kg";
  review?: {
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    branch?: string;
    pr_number?: number;
    files: string[];
    violations: ReviewViolation[];
    score: PrReviewEntry["score"];
  };
  blastRadius?: {
    total_affected: number;
    affected_files: number;
    by_depth: Record<number, number>;
    affected: Array<{ entity_name: string; entity_kind: string; file_path: string; depth: number }>;
  };
  hotspots: PrImpactHotspot[];
  subgraph: PrImpactSubgraph;
  decisions: Array<{
    principle_id: string;
    file_path: string;
    justification: string;
    category?: string;
  }>;
  empty_state?: string;
}

// ---------------------------------------------------------------------------
// Severity weight mapping
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS: Record<string, number> = {
  rule: 3,
  "strong-opinion": 2,
  convention: 1,
};

function severityWeight(severity: string): number {
  return SEVERITY_WEIGHTS[severity] ?? 1;
}

// ---------------------------------------------------------------------------
// Helper: buildHotspots
//
// For each file in the review, compute:
//   - violation_count: number of violations for that file
//   - blast_radius_count: count of blast radius entities originating from that file
//   - risk_score: blast_radius_count * max_severity_weight (or violation severity weight when no BR)
//
// Sort descending by risk_score.
// ---------------------------------------------------------------------------

function buildHotspots(
  review: PrReviewEntry,
  blastRadius: PrImpactOutput["blastRadius"] | undefined,
): PrImpactHotspot[] {
  // Index violations by file
  const violationsByFile = new Map<string, ReviewViolation[]>();
  for (const violation of review.violations) {
    const filePath = violation.file_path ?? "__unassigned__";
    const arr = violationsByFile.get(filePath) ?? [];
    arr.push(violation);
    violationsByFile.set(filePath, arr);
  }

  // Index blast radius count per file
  const blastByFile = new Map<string, number>();
  if (blastRadius) {
    for (const entry of blastRadius.affected) {
      if (entry.file_path) {
        blastByFile.set(entry.file_path, (blastByFile.get(entry.file_path) ?? 0) + 1);
      }
    }
  }

  const hotspots: PrImpactHotspot[] = review.files.map((file) => {
    const fileViolations = violationsByFile.get(file) ?? [];
    const blastCount = blastByFile.get(file) ?? 0;

    // risk_score = blast_radius_count * max_severity_weight across this file's violations
    const maxSeverityWeight = fileViolations.length > 0
      ? Math.max(...fileViolations.map((v) => severityWeight(v.severity)))
      : 0;

    // When no blast radius available, use violation count * max severity weight
    const riskScore = blastCount > 0
      ? blastCount * maxSeverityWeight
      : fileViolations.reduce((sum, v) => sum + severityWeight(v.severity), 0);

    return {
      file,
      blast_radius_count: blastCount,
      violation_count: fileViolations.length,
      risk_score: riskScore,
      violations: fileViolations.map((v) => ({
        principle_id: v.principle_id,
        severity: v.severity,
        message: v.message,
      })),
    };
  });

  // Sort descending by risk_score
  hotspots.sort((a, b) => b.risk_score - a.risk_score);

  return hotspots;
}

// ---------------------------------------------------------------------------
// Helper: buildSubgraph
//
// Reads graph-data.json and extracts a subgraph containing:
//   - Nodes that are in changedFiles or in blastRadius.affected (by file_path)
//   - Edges where BOTH source and target are in the filtered node set
//   - Layers derived from the filtered nodes
// ---------------------------------------------------------------------------

interface RawGraphNode {
  id: string;
  layer?: string;
  violation_count?: number;
  [key: string]: unknown;
}

interface RawGraphEdge {
  source: string;
  target: string;
  confidence?: number;
  [key: string]: unknown;
}

interface RawGraphData {
  nodes?: RawGraphNode[];
  edges?: RawGraphEdge[];
  [key: string]: unknown;
}

// Default layer colors (matches the dashboard palette)
const LAYER_COLORS: Record<string, string> = {
  tools: "#4e9af1",
  domain: "#f1a24e",
  api: "#4ef1a2",
  data: "#a24ef1",
  utils: "#f14e7c",
  infra: "#4ef1e6",
  ui: "#e6f14e",
  unknown: "#888888",
};

async function buildSubgraph(
  projectDir: string,
  changedFiles: string[],
  blastRadius: PrImpactOutput["blastRadius"] | undefined,
): Promise<PrImpactSubgraph> {
  const graphDataPath = join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);

  let rawGraph: RawGraphData;
  try {
    const raw = await readFile(graphDataPath, "utf-8");
    rawGraph = JSON.parse(raw) as RawGraphData;
  } catch {
    return { nodes: [], edges: [], layers: [] };
  }

  const allNodes: RawGraphNode[] = rawGraph.nodes ?? [];
  const allEdges: RawGraphEdge[] = rawGraph.edges ?? [];

  // Build inclusion set: changed files + blast radius affected files
  const includedPaths = new Set<string>(changedFiles);
  if (blastRadius) {
    for (const entry of blastRadius.affected) {
      if (entry.file_path) {
        includedPaths.add(entry.file_path);
      }
    }
  }

  // Filter nodes
  const filteredNodes: PrImpactSubgraphNode[] = allNodes
    .filter((n) => includedPaths.has(n.id))
    .map((n) => ({
      id: n.id,
      layer: n.layer ?? "unknown",
      changed: changedFiles.includes(n.id),
      violation_count: n.violation_count ?? 0,
    }));

  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

  // Filter edges — both endpoints must be in the subgraph
  const filteredEdges: PrImpactSubgraphEdge[] = allEdges
    .filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      confidence: e.confidence,
    }));

  // Extract layer summary
  const layerCounts = new Map<string, number>();
  for (const node of filteredNodes) {
    layerCounts.set(node.layer, (layerCounts.get(node.layer) ?? 0) + 1);
  }

  const layers = Array.from(layerCounts.entries()).map(([name, file_count]) => ({
    name,
    color: LAYER_COLORS[name] ?? LAYER_COLORS.unknown,
    file_count,
  }));

  return { nodes: filteredNodes, edges: filteredEdges, layers };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the PR impact payload for the most recent stored PR review.
 *
 * Returns structured empty states for missing data — never throws to the caller.
 */
export async function showPrImpact(projectDir: string): Promise<PrImpactOutput> {
  // 1. Load latest PR review
  const prStore = new PrStore(projectDir);
  const reviews = await prStore.getReviews();
  const latestReview = reviews.length > 0 ? reviews[reviews.length - 1] : null;

  if (!latestReview) {
    return {
      status: "no_review",
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      decisions: [],
      empty_state: "No PR review stored. Run the Canon reviewer first.",
    };
  }

  // 1b. Validate file paths from stored review (trust boundary)
  latestReview.files = latestReview.files.filter(
    (f) => safeResolvePath(projectDir, f) !== null,
  );
  latestReview.violations = latestReview.violations.filter(
    (v) => !v.file_path || safeResolvePath(projectDir, v.file_path) !== null,
  );

  // 2. Check KG availability
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const hasKg = existsSync(dbPath);

  // 3. Compute blast radius (if KG available)
  let blastRadius: PrImpactOutput["blastRadius"] = undefined;
  if (hasKg) {
    const db = initDatabase(dbPath);
    try {
      const report = analyzeBlastRadius(db, latestReview.files, { maxDepth: 3, includeTests: false });
      blastRadius = {
        total_affected: report.total_affected,
        affected_files: report.affected_files,
        by_depth: report.by_depth,
        affected: report.affected.map((e) => ({
          entity_name: e.entity_name,
          entity_kind: e.entity_kind,
          file_path: e.file_path,
          depth: e.depth,
        })),
      };
    } catch {
      // KG query failed — continue without blast radius
    } finally {
      db.close();
    }
  }

  // 4. Build hotspot list (ranked by risk_score)
  const hotspots = buildHotspots(latestReview, blastRadius);

  // 5. Build subgraph from graph-data.json (filtered to changed + affected files)
  const subgraph = await buildSubgraph(projectDir, latestReview.files, blastRadius);

  // 6. Load relevant decisions (cross-referenced with violated principles)
  const driftStore = new DriftStore(projectDir);
  const violatedPrinciples = new Set(latestReview.violations.map((v) => v.principle_id));
  const allDecisions = await driftStore.getDecisions();
  const relevantDecisions = allDecisions.filter((d) => violatedPrinciples.has(d.principle_id));

  return {
    status: "ok",
    review: {
      verdict: latestReview.verdict,
      branch: latestReview.branch,
      pr_number: latestReview.pr_number,
      files: latestReview.files,
      violations: latestReview.violations,
      score: latestReview.score,
    },
    blastRadius,
    hotspots,
    subgraph,
    decisions: relevantDecisions.map((d) => ({
      principle_id: d.principle_id,
      file_path: d.file_path,
      justification: d.justification,
      category: d.category,
    })),
  };
}
