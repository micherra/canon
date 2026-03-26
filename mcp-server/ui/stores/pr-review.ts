/**
 * stores/pr-review.ts
 *
 * Type definitions for the unified PR Review View payload.
 * Mirrored from src/tools/show-pr-impact.ts to avoid server/UI boundary coupling.
 * Replaces stores/pr-impact.ts (deleted 2026-03-25 — merged into unified show_pr_impact).
 */

export interface PrFileInfo {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
  bucket: "needs-attention" | "worth-a-look" | "low-risk";
  reason: string;
  priority_score?: number;
  priority_factors?: {
    in_degree: number;
    violation_count: number;
    is_changed: boolean;
    layer: string;
    layer_centrality: number;
  };
  violations?: Array<{
    principle_id: string;
    severity: "rule" | "strong-opinion" | "convention";
    message?: string;
  }>;
}

export interface BlastRadiusEntry {
  file: string;
  affected: Array<{ path: string; depth: number }>;
}

export interface Subsystem {
  directory: string;
  label: "new" | "removed";
  file_count: number;
}

export interface BlastRadiusFileEntry {
  file: string;
  dep_count: number;
}

export interface PrepData {
  files: PrFileInfo[];
  layers: Array<{ name: string; file_count: number }>;
  total_files: number;
  incremental: boolean;
  last_reviewed_sha?: string;
  diff_command: string;
  narrative: string;
  blast_radius: BlastRadiusEntry[];
  graph_data_age_ms?: number;
  error?: string;
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

export interface UnifiedPrOutput {
  status: "ok" | "no_diff_error";
  prep: PrepData;
  review?: {
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    branch?: string;
    pr_number?: number;
    files: string[];
    violations: Array<{
      principle_id: string;
      severity: string;
      file_path?: string;
      impact_score?: number;
      message?: string;
    }>;
    score: {
      rules: { passed: number; total: number };
      opinions: { passed: number; total: number };
      conventions: { passed: number; total: number };
    };
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
  has_review: boolean;
  empty_state?: string;
  subsystems: Subsystem[];
  blast_radius_by_file: BlastRadiusFileEntry[];
}
