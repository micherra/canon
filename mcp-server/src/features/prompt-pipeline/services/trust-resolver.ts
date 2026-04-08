/**
 * TrustResolver — pure function module for KG-informed trust computation.
 *
 * Computes a TrustLevel from typed inputs (agent write capability, task scope,
 * file metrics, KG freshness). No I/O — callers are responsible for providing
 * all data. This module has no imports from @graph/* or any I/O modules.
 *
 * Canon alignment:
 * - fail-closed-by-default: every degradation path returns LOW or BLOCKED
 * - functions-do-one-thing: each export has one responsibility
 * - deep-modules: callers invoke one function and get a result; logic is hidden here
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustLevel = "HIGH" | "MEDIUM" | "LOW" | "BLOCKED";

export type TrustResult = {
  level: TrustLevel;
  reason: string;
};

/** Aggregated file metrics for the task scope. */
export type ScopeFileMetrics = {
  hasHubFile: boolean;
  hasHighDegreeFile: boolean;
  /** Carried forward for Phase 2 hook gate — not used in Phase 1 trust computation. */
  hasCycleFile: boolean;
};

export type TrustInput = {
  agent: string;
  /** Whether the agent has Write or Edit in its base profile */
  agentCanWrite: boolean;
  /** File paths in the resolved task scope */
  taskScope: string[];
  /** Aggregated metrics for scope files */
  scopeMetrics: ScopeFileMetrics;
  /** KG freshness in ms (null = KG not available) */
  kgFreshnessMs: number | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_DEGREE_THRESHOLD = 8;
const KG_STALENESS_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// computeTrustLevel
// ---------------------------------------------------------------------------

/**
 * Compute a TrustLevel from a TrustInput.
 *
 * Priority order (fail-closed — each gate returns early on degradation):
 * 1. KG unavailable → LOW
 * 2. KG stale → LOW
 * 3. Agent cannot write → BLOCKED
 * 4. Empty task scope → LOW
 * 5. No hub/high-degree files → HIGH
 * 6. Hub or high-degree files present → MEDIUM
 * 7. Fallback → LOW
 */
export const computeTrustLevel = (input: TrustInput): TrustResult => {
  const { agent, agentCanWrite, kgFreshnessMs, scopeMetrics, taskScope } = input;

  // Gate 1: KG unavailable
  if (kgFreshnessMs === null) {
    return { level: "LOW", reason: "KG not available" };
  }

  // Gate 2: KG stale
  if (kgFreshnessMs > KG_STALENESS_MS) {
    return { level: "LOW", reason: `KG data stale (>${kgFreshnessMs}ms)` };
  }

  // Gate 3: Agent cannot write
  if (!agentCanWrite) {
    return { level: "BLOCKED", reason: `Agent ${agent} has no write capability` };
  }

  // Gate 4: Empty task scope
  if (taskScope.length === 0) {
    return { level: "LOW", reason: "Empty task scope — no trust perimeter" };
  }

  // Gate 5: Low-risk scope files → HIGH
  if (!scopeMetrics.hasHubFile && !scopeMetrics.hasHighDegreeFile) {
    return { level: "HIGH", reason: "All scope files are low-risk" };
  }

  // Gate 6: Hub or high-degree files → MEDIUM
  if (scopeMetrics.hasHubFile || scopeMetrics.hasHighDegreeFile) {
    return { level: "MEDIUM", reason: "Scope contains hub or high-degree files" };
  }

  // Fallback (should not reach in practice)
  return { level: "LOW", reason: "Default fallback" };
};

// ---------------------------------------------------------------------------
// trustLevelToPermissionMode
// ---------------------------------------------------------------------------

/**
 * Map a TrustLevel to permission_mode value.
 *
 * BLOCKED maps to "prompt" (not "deny_unknown") because non-writer agents
 * already can't write via their base profile disallowed list. Using "deny_unknown"
 * would unexpectedly block legitimate MCP tool calls (e.g., graph_query, semantic_search)
 * that are in the agent's allowed list.
 */
export const trustLevelToPermissionMode = (level: TrustLevel): "auto" | "prompt" => {
  switch (level) {
    case "HIGH":
    case "MEDIUM":
      return "auto";
    case "LOW":
    case "BLOCKED":
      return "prompt";
  }
};

// ---------------------------------------------------------------------------
// buildScopeMetrics
// ---------------------------------------------------------------------------

/**
 * Build ScopeFileMetrics from per-file KG metrics. Pure aggregation — no DB access.
 *
 * Null entries represent files not indexed in the KG; they are treated as low-risk
 * (conservative assumption: we don't know the file's risk, so we don't flag it).
 */
export const buildScopeMetrics = (
  fileMetrics: Array<{ isHub: boolean; inDegree: number; inCycle: boolean } | null>,
): ScopeFileMetrics => {
  let hasHubFile = false;
  let hasHighDegreeFile = false;
  let hasCycleFile = false;

  for (const entry of fileMetrics) {
    if (entry === null) {
      // Unindexed file — treat as low-risk, skip
      continue;
    }
    if (entry.isHub) hasHubFile = true;
    if (entry.inDegree > HIGH_DEGREE_THRESHOLD) hasHighDegreeFile = true;
    if (entry.inCycle) hasCycleFile = true;
  }

  return { hasCycleFile, hasHighDegreeFile, hasHubFile };
};
