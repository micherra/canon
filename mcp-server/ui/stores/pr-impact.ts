/**
 * stores/pr-impact.ts
 *
 * Type definitions for the PR Impact View payload.
 * Mirrored from src/tools/show-pr-impact.ts to avoid server/UI boundary coupling.
 */

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
  empty_state?: string;
}
