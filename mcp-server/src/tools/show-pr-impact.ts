/**
 * show_pr_impact — Server-side tool handler
 *
 * Assembles a UnifiedPrOutput by orchestrating multiple data sources:
 *   1. Live diff prep data via getPrReviewData (always present)
 *   2. Latest PR review from DriftStore (optional — impact overlay)
 *   3. Blast radius analysis via analyzeBlastRadius (when KG is available)
 *   4. Subgraph extraction from graph-data.json (filtered to blast radius affected files)
 *   5. Risk-ranked hotspot list (blast radius size × severity weight)
 *
 * Graceful degradation:
 *   - No stored review → prep data always present; review/hotspots/subgraph empty
 *   - KG absent → blast radius and subgraph empty, review data still returned
 *   - KG query throws → continues without blast radius
 *
 * Canon principles:
 *   - functions-do-one-thing: showPrImpact assembles one payload; helpers handle sub-tasks
 *   - deep-modules: simple (projectDir, options?) → (UnifiedPrOutput) interface; complexity hidden
 *   - validate-at-trust-boundaries: structured errors/empty states, never throws to caller
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { DriftStore } from "../drift/store.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgQuery } from "../graph/kg-query.ts";
import type { ReviewEntry, ReviewViolation } from "../schema.ts";
import type { PrReviewDataOutput } from "./pr-review-data.ts";
import { getPrReviewData } from "./pr-review-data.ts";

/** Resolve a project-relative path safely. Returns null on traversal attempts. */
function safeResolvePath(projectDir: string, filePath: string): string | null {
  if (isAbsolute(filePath)) return null;
  if (filePath.includes("..")) return null;
  const resolved = resolve(projectDir, filePath);
  if (!resolved.startsWith(`${projectDir}/`) && resolved !== projectDir) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A detected subsystem — a directory with a significant number of added or
 * removed files, signalling the emergence or retirement of a code area.
 */
export interface Subsystem {
  directory: string;
  label: "new" | "removed";
  file_count: number;
}

/**
 * Per-file blast radius summary — how many entities are affected by changes
 * to a given file (derived from existing blastRadius.affected data).
 */
export interface BlastRadiusFileEntry {
  file: string;
  dep_count: number;
}

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
    score: ReviewEntry["score"];
    honored: string[];
  };
  blastRadius?: {
    total_affected: number;
    affected_files: number;
    by_depth: Record<number, number>;
    affected: Array<{ entity_name: string; entity_kind: string; file_path: string; depth: number }>;
  };
  hotspots: PrImpactHotspot[];
  subgraph: PrImpactSubgraph;
  empty_state?: string;
}

/**
 * A holistic recommendation — a code improvement suggestion that may come from
 * principle compliance analysis or broader code quality observations.
 */
export interface PrRecommendation {
  file_path?: string;
  title: string;
  message: string;
  source: "principle" | "holistic";
}

/**
 * Unified output type for show_pr_impact.
 * prep is always present (live diff analysis).
 * review/blastRadius/hotspots/subgraph are impact layer fields (present when a stored review exists).
 */
export interface UnifiedPrOutput {
  status: "ok" | "no_diff_error";
  /** Live diff prep data — always populated */
  prep: PrReviewDataOutput;
  /** Whether a stored Canon review exists for this PR/branch — drives UI review-mode layout */
  has_review: boolean;
  /** Stored review data — only present when a Canon review exists in DriftStore */
  review?: PrImpactOutput["review"];
  /** Blast radius analysis — only when KG is available and review exists */
  blastRadius?: PrImpactOutput["blastRadius"];
  /** Risk-ranked hotspot list — empty when no stored review */
  hotspots: PrImpactHotspot[];
  /** Subgraph filtered to changed + affected files — empty when no stored review */
  subgraph: PrImpactSubgraph;
  /** Detected subsystems — directories with 3+ added (label: "new") or 3+ deleted (label: "removed") files */
  subsystems: Subsystem[];
  /** Per-file blast radius dep counts — derived from blastRadius.affected; top 15 by dep_count */
  blast_radius_by_file: BlastRadiusFileEntry[];
  /** Holistic recommendations from the reviewer — mixed principle and code quality suggestions */
  recommendations?: PrRecommendation[];
  empty_state?: string;
}

// ---------------------------------------------------------------------------
// Helper: detectSubsystems
//
// Groups files by their first two directory segments. Emits a Subsystem entry
// for each group that has >= 3 added files (label: "new") or >= 3 deleted files
// (label: "removed"). Results are sorted descending by file_count.
// ---------------------------------------------------------------------------

/**
 * Detect emerging or retiring subsystems from a list of changed files.
 *
 * @param files     - file paths (project-relative)
 * @param statusMap - map from file path to git status (e.g., "added", "deleted", "modified")
 * @returns list of detected subsystems sorted by file_count descending
 */
export function detectSubsystems(files: string[], statusMap: Map<string, string>): Subsystem[] {
  const counts = new Map<string, { new: number; removed: number }>();

  for (const file of files) {
    const segments = file.split("/");
    const dir = segments.length <= 1 ? "." : segments.slice(0, 2).join("/");

    const stats = counts.get(dir) ?? { new: 0, removed: 0 };
    const status = statusMap.get(file);
    if (status === "added") stats.new++;
    if (status === "deleted") stats.removed++;
    counts.set(dir, stats);
  }

  const result: Subsystem[] = [];
  for (const [directory, stats] of counts.entries()) {
    if (stats.new >= 3) result.push({ directory, label: "new", file_count: stats.new });
    if (stats.removed >= 3) result.push({ directory, label: "removed", file_count: stats.removed });
  }

  return result.sort((a, b) => b.file_count - a.file_count);
}

// ---------------------------------------------------------------------------
// Helper: buildBlastRadiusByFile
//
// Derives a per-file dependency count from the existing blastRadius.affected
// data — no new KG queries needed. Groups entries by file_path, counts entities
// per file, returns sorted descending by dep_count, limited to top 15.
// ---------------------------------------------------------------------------

/**
 * Build a per-file dependency count from blast radius affected entities.
 *
 * @param blastRadius - the blast radius analysis output (or undefined if unavailable)
 * @returns top-15 entries sorted by dep_count descending
 */
export function buildBlastRadiusByFile(blastRadius: PrImpactOutput["blastRadius"] | undefined): BlastRadiusFileEntry[] {
  if (!blastRadius) return [];

  const countByFile = new Map<string, number>();
  for (const entry of blastRadius.affected) {
    if (entry.file_path) {
      countByFile.set(entry.file_path, (countByFile.get(entry.file_path) ?? 0) + 1);
    }
  }

  const entries: BlastRadiusFileEntry[] = Array.from(countByFile.entries()).map(([file, dep_count]) => ({
    file,
    dep_count,
  }));

  entries.sort((a, b) => b.dep_count - a.dep_count);
  return entries.slice(0, 15);
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

function buildHotspots(review: ReviewEntry, blastRadius: PrImpactOutput["blastRadius"] | undefined): PrImpactHotspot[] {
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
    const maxSeverityWeight =
      fileViolations.length > 0 ? Math.max(...fileViolations.map((v) => severityWeight(v.severity))) : 0;

    // When no blast radius available, use violation count * max severity weight
    const riskScore =
      blastCount > 0
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
// Queries the KG database for a subgraph containing:
//   - Nodes that are in changedFiles or in blastRadius.affected (by file_path)
//   - Edges where BOTH source and target are in the filtered node set
//   - Layers derived from the filtered nodes
// ---------------------------------------------------------------------------

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

function buildSubgraph(
  db: ReturnType<typeof initDatabase> | null,
  changedFiles: string[],
  blastRadius: PrImpactOutput["blastRadius"] | undefined,
  violationCountByFile?: Map<string, number>,
): PrImpactSubgraph {
  if (!db) return { nodes: [], edges: [], layers: [] };

  // Build inclusion set: changed files + blast radius affected files
  const includedPaths = new Set<string>(changedFiles);
  if (blastRadius) {
    for (const entry of blastRadius.affected) {
      if (entry.file_path) {
        includedPaths.add(entry.file_path);
      }
    }
  }

  if (includedPaths.size === 0) return { nodes: [], edges: [], layers: [] };

  const query = new KgQuery(db);
  const rawSubgraph = query.getSubgraph([...includedPaths]);

  // Map KgQuery nodes to PrImpactSubgraphNode
  const changedSet = new Set(changedFiles);
  const filteredNodes: PrImpactSubgraphNode[] = rawSubgraph.nodes
    .filter(n => includedPaths.has(n.path))
    .map(n => ({
      id: n.path,
      layer: n.layer ?? "unknown",
      changed: changedSet.has(n.path),
      violation_count: violationCountByFile?.get(n.path) ?? 0,
    }));

  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

  // Filter edges — both endpoints must be in the subgraph inclusion set
  const filteredEdges: PrImpactSubgraphEdge[] = rawSubgraph.edges
    .filter(e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target))
    .map(e => ({ source: e.source, target: e.target }));

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
 * Assemble the unified PR review payload.
 *
 * Always calls getPrReviewData for live diff prep data.
 * When a stored Canon review exists in DriftStore, overlays blast radius,
 * hotspots, subgraph, and decisions on top of the prep data.
 *
 * When options.branch or options.pr_number are provided, filters to reviews
 * matching those criteria. Falls back to all reviews (latest) when no filter given.
 *
 * Returns structured empty states for missing data — never throws to the caller.
 */
export async function showPrImpact(
  projectDir: string,
  options?: { branch?: string; pr_number?: number; diff_base?: string; incremental?: boolean },
): Promise<UnifiedPrOutput> {
  // 1. Always gather live diff prep data
  const prepResult = await getPrReviewData(
    {
      pr_number: options?.pr_number,
      branch: options?.branch,
      diff_base: options?.diff_base,
      incremental: options?.incremental,
    },
    projectDir,
  );

  // 2. Load latest stored PR review (optionally filtered by branch/pr_number)
  const driftStore = new DriftStore(projectDir);
  const hasFilter = options?.branch !== undefined || options?.pr_number !== undefined;
  const reviews = await driftStore.getReviews({
    branch: options?.branch,
    prNumber: options?.pr_number,
  });
  // When no explicit filter, only consider reviews with PR context
  const prReviews = hasFilter ? reviews : reviews.filter((r) => r.pr_number !== undefined || r.branch !== undefined);
  const latestReview = prReviews.length > 0 ? prReviews[prReviews.length - 1] : null;

  // When no stored review, return prep data only
  if (!latestReview) {
    return {
      status: "ok",
      prep: prepResult,
      has_review: false,
      hotspots: [],
      subgraph: { nodes: [], edges: [], layers: [] },
      subsystems: [],
      blast_radius_by_file: [],
    };
  }

  // 2b. Validate file paths from stored review (trust boundary)
  latestReview.files = latestReview.files.filter((f) => safeResolvePath(projectDir, f) !== null);
  latestReview.violations = latestReview.violations.filter(
    (v) => !v.file_path || safeResolvePath(projectDir, v.file_path) !== null,
  );

  // 3. Check KG availability
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const hasKg = existsSync(dbPath);

  // 4. Compute blast radius and subgraph from KG (if available)
  let blastRadius: PrImpactOutput["blastRadius"];
  let subgraph: PrImpactSubgraph = { nodes: [], edges: [], layers: [] };
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
    }

    // 6. Build subgraph from KG (filtered to changed + affected files)
    try {
      // Build per-file violation counts from the stored review
      const violationCountByFile = new Map<string, number>();
      for (const v of latestReview.violations) {
        if (v.file_path) {
          violationCountByFile.set(v.file_path, (violationCountByFile.get(v.file_path) ?? 0) + 1);
        }
      }
      subgraph = buildSubgraph(db, latestReview.files, blastRadius, violationCountByFile);
    } catch {
      // Subgraph build failed — continue with empty subgraph
    }

    db.close();
  }

  // 5. Build hotspot list (ranked by risk_score)
  const hotspots = buildHotspots(latestReview, blastRadius);

  // 7. Detect subsystems — cross-reference review files with prep file statuses
  const statusMap = new Map<string, string>();
  for (const prepFile of prepResult.files) {
    statusMap.set(prepFile.path, prepFile.status);
  }
  const subsystems = detectSubsystems(latestReview.files, statusMap);

  // 9. Build per-file blast radius counts (top 15 by dep_count)
  const blast_radius_by_file = buildBlastRadiusByFile(blastRadius);

  return {
    status: "ok",
    prep: prepResult,
    has_review: true,
    review: {
      verdict: latestReview.verdict,
      branch: latestReview.branch,
      pr_number: latestReview.pr_number,
      files: latestReview.files,
      violations: latestReview.violations,
      score: latestReview.score,
      honored: latestReview.honored ?? [],
    },
    blastRadius,
    hotspots,
    subgraph,
    subsystems,
    blast_radius_by_file,
    ...(latestReview.recommendations !== undefined ? { recommendations: latestReview.recommendations } : {}),
  };
}
