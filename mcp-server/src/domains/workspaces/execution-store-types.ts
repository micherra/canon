/**
 * Types and helpers for ExecutionStore.
 * Extracted from execution-store.ts to keep each file under 600 lines.
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";

// Row types (internal — not exported; callers receive typed objects)

export type ExecutionRow = {
  id: number;
  flow: string;
  task: string;
  entry: string;
  current_state: string;
  base_commit: string;
  started: string;
  last_updated: string;
  blocked: string | null; // JSON: BlockedInfo | null
  concerns: string; // JSON array
  skipped: string; // JSON array
  metadata: string | null; // JSON object | null
  branch: string;
  sanitized: string;
  created: string;
  original_task: string | null;
  tier: string;
  flow_name: string;
  slug: string;
  status: string;
  completed_at: string | null;
  rolled_back_at: string | null;
  rolled_back_to: string | null;
  correlation_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
};

export type ExecutionStateRow = {
  state_id: string;
  status: string;
  entries: number;
  entered_at: string | null;
  completed_at: string | null;
  result: string | null;
  artifacts: string | null; // JSON array | null
  artifact_history: string | null; // JSON array | null
  error: string | null;
  wave: number | null;
  wave_total: number | null;
  wave_results: string | null; // JSON object | null
  metrics: string | null; // JSON object | null
  gate_results: string | null; // JSON array | null
  postcondition_results: string | null; // JSON array | null
  discovered_gates: string | null; // JSON array | null
  discovered_postconditions: string | null; // JSON array | null
  parallel_results: string | null; // JSON array | null
  compete_results: string | null; // JSON array | null
  synthesized: number | null; // 0/1 | null
  transcript_path: string | null; // ADR-015
  inserted_return_to: string | null; // ADR-012
};

export type IterationRow = {
  state_id: string;
  count: number;
  max: number;
  history: string; // JSON array
  cannot_fix: string; // JSON array
};

export type ProgressRow = {
  id: number;
  line: string;
  timestamp: string;
};

export type MessageRow = {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
};

export type WaveEventRow = {
  id: string;
  type: string;
  payload: string; // JSON
  timestamp: string;
  status: string;
  applied_at: string | null;
  resolution: string | null; // JSON | null
  rejection_reason: string | null;
};

// Parameter types for public API

export type InitExecutionParams = {
  flow: string;
  task: string;
  entry: string;
  current_state: string;
  base_commit: string;
  started: string;
  last_updated: string;
  branch: string;
  sanitized: string;
  created: string;
  original_task?: string;
  tier: "small" | "medium" | "large";
  flow_name: string;
  slug: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
  worktree_path?: string;
  worktree_branch?: string;
};

export type UpdateExecutionFields = {
  current_state?: string;
  blocked?: Board["blocked"];
  concerns?: Board["concerns"];
  skipped?: string[];
  metadata?: Board["metadata"];
  last_updated?: string;
  status?: string;
  completed_at?: string;
  rolled_back_at?: string;
  rolled_back_to?: string;
  worktree_path?: string | null;
  worktree_branch?: string | null;
};

export type MessageOutput = {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
};

export type GetMessagesOptions = {
  since?: string;
};

export type GetWaveEventsOptions = {
  status?: string;
};

export type UpdateWaveEventFields = {
  status?: string;
  applied_at?: string;
  resolution?: Record<string, unknown>;
  rejection_reason?: string;
};

export type GetEventsOptions = {
  correlation_id?: string;
  type?: string;
  since?: string;
  limit?: number;
};

export type EventOutput = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  timestamp: string;
};

// Helper — parse nullable JSON column

export function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

// Module-level constants

/** Allowlist of columns updateExecution is permitted to SET. Hoisted to avoid recreation per call. */
export const ALLOWED_UPDATE_EXECUTION_COLUMNS = new Set([
  "current_state",
  "blocked",
  "concerns",
  "skipped",
  "metadata",
  "status",
  "completed_at",
  "rolled_back_at",
  "rolled_back_to",
  "last_updated",
  "worktree_path",
  "worktree_branch",
]);

// Private helpers — stuck detection (used by ExecutionStore.isStuck)

export function setsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/** Order-insensitive comparison for arrays of objects (e.g. file+test pairs). */
export function unorderedEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const serialize = (item: unknown) =>
    JSON.stringify(item, Object.keys(item as Record<string, unknown>).sort());
  const sortedA = a.map(serialize).sort();
  const sortedB = b.map(serialize).sort();
  return sortedA.every((val, i) => val === sortedB[i]);
}
