/**
 * Pure functions for status normalization and transition evaluation.
 */

import type {
  StateDefinition,
  StuckWhen,
  HistoryEntry,
  ViolationHistoryEntry,
  FileTestHistoryEntry,
  StatusHistoryEntry,
  ProgressHistoryEntry,
} from "./flow-schema.js";
import { STATUS_ALIASES } from "./flow-schema.js";

/**
 * Lowercase the input and apply alias mapping to produce a normalized
 * condition string suitable for transition lookups.
 */
export function normalizeStatus(raw: string): string {
  const lowered = raw.toLowerCase();
  return STATUS_ALIASES[lowered] ?? lowered;
}

/**
 * Look up a condition in a state's transitions map.
 * Returns the target state name, or null if no matching transition exists.
 */
export function evaluateTransition(
  state: StateDefinition,
  condition: string,
): string | null {
  if (!state.transitions) return null;
  return state.transitions[condition] ?? null;
}

/**
 * When reviewThreshold is "warning" and the condition is "warning",
 * upgrade to whatever the "blocking" transition targets instead.
 * Otherwise return the original condition unchanged.
 */
export function applyReviewThresholdToCondition(
  reviewThreshold: "blocking" | "warning" | undefined,
  condition: string,
  transitions: Record<string, string>,
): string {
  if (reviewThreshold === "warning" && condition === "warning") {
    // Upgrade: treat warning as blocking
    return transitions["blocking"] !== undefined ? "blocking" : condition;
  }
  return condition;
}

/**
 * Build a history entry shaped by the stuck_when strategy.
 */
export function buildHistoryEntry(
  stuckWhen: StuckWhen,
  data: {
    principleIds?: string[];
    filePaths?: string[];
    pairs?: { file: string; test: string }[];
    status?: string;
    commitSha?: string;
    artifactCount?: number;
  },
): HistoryEntry {
  switch (stuckWhen) {
    case "same_violations":
      return {
        principle_ids: data.principleIds ?? [],
        file_paths: data.filePaths ?? [],
      };
    case "same_file_test":
      return {
        pairs: data.pairs ?? [],
      };
    case "same_status":
      return {
        status: data.status ?? "",
      };
    case "no_progress":
      return {
        commit_sha: data.commitSha ?? "",
        artifact_count: data.artifactCount ?? 0,
      };
  }
}

/**
 * Compare the two most recent history entries to determine if the agent
 * is stuck (making no meaningful progress). Returns false if fewer than
 * 2 entries exist.
 */
export function isStuck(history: HistoryEntry[], stuckWhen: StuckWhen): boolean {
  if (history.length < 2) return false;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  switch (stuckWhen) {
    case "same_violations": {
      const p = prev as ViolationHistoryEntry;
      const c = curr as ViolationHistoryEntry;
      return setsEqual(new Set(p.principle_ids), new Set(c.principle_ids))
        && setsEqual(new Set(p.file_paths), new Set(c.file_paths));
    }
    case "same_file_test": {
      const p = prev as FileTestHistoryEntry;
      const c = curr as FileTestHistoryEntry;
      if (p.pairs.length !== c.pairs.length) return false;
      return c.pairs.every((cp) =>
        p.pairs.some((pp) => pp.file === cp.file && pp.test === cp.test),
      );
    }
    case "same_status": {
      const p = prev as StatusHistoryEntry;
      const c = curr as StatusHistoryEntry;
      return p.status === c.status;
    }
    case "no_progress": {
      const p = prev as ProgressHistoryEntry;
      const c = curr as ProgressHistoryEntry;
      return p.commit_sha === c.commit_sha && p.artifact_count === c.artifact_count;
    }
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** A single result from a parallel-per agent execution. */
export interface ParallelPerResult {
  status: string;
  item?: string;
  artifacts?: string[];
}

/**
 * Aggregate results from a parallel-per execution into a single
 * condition and a list of items that could not be fixed.
 */
export function aggregateParallelPerResults(
  results: ParallelPerResult[],
): { condition: string; cannotFixItems: string[] } {
  const hasBlocked = results.some((r) => r.status === "blocked");
  if (hasBlocked) {
    return { condition: "blocked", cannotFixItems: [] };
  }

  const doneResults = results.filter((r) => r.status === "done");
  const cannotFixResults = results.filter((r) => r.status === "cannot_fix");

  if (cannotFixResults.length === results.length) {
    return {
      condition: "cannot_fix",
      cannotFixItems: cannotFixResults.map((r) => r.item).filter((i): i is string => i !== undefined),
    };
  }

  if (doneResults.length === results.length) {
    return { condition: "done", cannotFixItems: [] };
  }

  // Mixed: some done, some cannot_fix
  return {
    condition: "done",
    cannotFixItems: cannotFixResults.map((r) => r.item).filter((i): i is string => i !== undefined),
  };
}
