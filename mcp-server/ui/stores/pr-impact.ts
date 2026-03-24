/**
 * stores/pr-impact.ts
 *
 * Reactive state for the PR Impact View.
 *
 * Uses Svelte writable stores (not module-level $state runes) because
 * Svelte 5 module-level $state only works in .svelte.ts files, not plain .ts
 * files. This matches the pattern used by other stores in this directory.
 *
 * Canon principles:
 *   - functions-do-one-thing: each exported function does one thing
 *   - information-hiding: hides bridge call details from components
 *   - validate-at-trust-boundaries: structured empty states, never throws
 */

import { writable } from "svelte/store";
import { bridge } from "./bridge";

// ---------------------------------------------------------------------------
// Types (mirrored from src/tools/show-pr-impact.ts to avoid server/UI boundary)
// ---------------------------------------------------------------------------

export type PrImpactStatus = "loading" | "ready" | "error";

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

export interface PrImpactPayload {
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

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

export const status = writable<PrImpactStatus>("loading");
export const payload = writable<PrImpactPayload | null>(null);
export const selectedFile = writable<string | null>(null);
export const error = writable<string>("");

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Load PR impact data from the server via bridge.
 * Updates status, payload, and error stores.
 */
export async function loadPrImpact(): Promise<void> {
  status.set("loading");
  error.set("");
  try {
    const result = await bridge.request("getPrImpact");
    payload.set(result as PrImpactPayload);
    status.set("ready");
  } catch (e) {
    status.set("error");
    error.set(e instanceof Error ? e.message : "Failed to load PR impact data");
  }
}

/**
 * Select a file in the hotspot list.
 * Pass null to deselect.
 */
export function selectFile(file: string | null): void {
  selectedFile.set(file);
}
