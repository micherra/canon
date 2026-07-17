/**
 * Run Summary Builder — extracts structured data from workspace files for cross-run analysis.
 *
 * Each extraction function is independently wrapped in try/catch.
 * Parse errors return partial/empty data. Missing dirs/files return null/empty.
 * buildRunSummary always returns a valid RunSummary — never throws.
 *
 * Canon principles:
 *   - fail-closed-by-default: extraction errors return partial data, not exceptions
 *   - validate-at-trust-boundaries: file contents are validated before use
 *   - bounded-context-boundaries: only imports from platform and node builtins; may import @domains
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateMetrics } from "../../../domains/flows/board-state-schemas.ts";
import type {
  AssembledArtifact,
  ContextProvenanceSummary,
} from "../../../domains/workspaces/context-provenance.ts";
import { getExecutionStore } from "../../../domains/workspaces/execution-store-cache.ts";
import type {
  ArtifactInventory,
  PlannerContext,
  ReviewResult,
  RunbookStep,
  RunSummary,
  StepOutcome,
} from "./archive-types.ts";
import {
  parsePlanningBrief,
  parseReviewFile,
  parseRunbookSteps,
} from "./run-summary-extractors.ts";

// ---- Public API ----

/**
 * Build a complete RunSummary from workspace files.
 * Always returns a valid RunSummary — never throws.
 */
export function buildRunSummary(input: {
  workspacePath: string;
  slug: string;
  archiveId: string;
  metadata: {
    branch: string;
    flow: string;
    tier: string;
    task: string;
    archivedAt: string;
  };
}): RunSummary {
  const { workspacePath, slug, archiveId, metadata } = input;

  const plansDir = join(workspacePath, "plans");
  const plannerContext = extractPlannerContext(plansDir, slug);
  const stepOutcomes = extractStepOutcomes(workspacePath);
  const reviewResults = extractReviewResults(workspacePath);
  // buildArtifactInventory scans the workspace directory tree — it must run before
  // any getExecutionStore() call (joinRecordedMetrics, extractContextProvenance
  // below), which lazily creates orchestration.db{,-shm,-wal} as a side effect and
  // would otherwise inflate the inventory's file count.
  const artifactInventory = buildArtifactInventory(workspacePath);
  joinRecordedMetrics(workspacePath, stepOutcomes);
  const contextProvenance = extractContextProvenance(workspacePath);

  // Compute timing from step outcomes
  const { startedAt, completedAt, totalDurationMs } = computeTiming(stepOutcomes);

  return {
    archive_id: archiveId,
    artifact_inventory: artifactInventory,
    context_provenance: contextProvenance,
    // decision_summaries is always empty — retained for version: 1 backward compatibility
    decision_summaries: [] as const,
    planner_context: plannerContext,
    review_results: reviewResults,
    run_metadata: {
      archived_at: metadata.archivedAt,
      branch: metadata.branch,
      completed_at: completedAt,
      flow: metadata.flow,
      slug,
      started_at: startedAt,
      task: metadata.task,
      tier: metadata.tier,
      total_duration_ms: totalDurationMs,
    },
    step_outcomes: stepOutcomes,
    version: 1,
  };
}

/**
 * Extract planner context from planning-brief.md and runbook.md.
 * Returns null if neither file exists; partial data if only one exists.
 */
function extractPlannerContext(plansDir: string, slug: string): PlannerContext | null {
  const briefPath = join(plansDir, slug, "planning-brief.md");
  const runbookPath = join(plansDir, slug, "runbook.md");

  const hasBrief = existsSync(briefPath);
  const hasRunbook = existsSync(runbookPath);

  if (!hasBrief && !hasRunbook) {
    return null;
  }

  let outcome = "";
  let effortEstimate = "";
  let valueEstimate = "";
  let assumptions: string[] = [];
  let recommendedApproach = "";
  let runbookSteps: RunbookStep[] = [];

  if (hasBrief) {
    try {
      const content = readFileSync(briefPath, "utf-8");
      ({ outcome, effortEstimate, valueEstimate, assumptions, recommendedApproach } =
        parsePlanningBrief(content));
    } catch {
      // Silently return defaults — extraction errors don't fail the summary
    }
  }

  if (hasRunbook) {
    try {
      const content = readFileSync(runbookPath, "utf-8");
      runbookSteps = parseRunbookSteps(content);
    } catch {
      // Silently return defaults
    }
  }

  return {
    assumptions,
    effort_estimate: effortEstimate,
    outcome,
    recommended_approach: recommendedApproach,
    runbook_steps: runbookSteps,
    value_estimate: valueEstimate,
  };
}

/**
 * Extract step outcomes from journal.json.
 * Returns empty array when journal.json is missing or malformed.
 */
function extractStepOutcomes(workspacePath: string): StepOutcome[] {
  const journalPath = join(workspacePath, "journal.json");
  if (!existsSync(journalPath)) {
    return [];
  }

  try {
    const raw = readFileSync(journalPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isObject(parsed) || !Array.isArray((parsed as Record<string, unknown>).steps)) {
      return [];
    }

    const steps = (parsed as Record<string, unknown>).steps as unknown[];
    return steps.map(stepToOutcome);
  } catch {
    return [];
  }
}

/**
 * Narrow a state's raw metrics down to StepOutcome.metrics' archive-safe shape
 * (numbers, strings, and the #473 stage_metrics nested-counter shape).
 * Orchestrator-only structured fields (gate_results, test_results,
 * postcondition_results, violation_severities) are dropped — StepOutcome.metrics
 * tracks agent-recorded counters, not gate/test bookkeeping.
 * Returns undefined when nothing archivable remains.
 */
function pickArchivableMetrics(metrics: StateMetrics): StepOutcome["metrics"] | undefined {
  const picked: NonNullable<StepOutcome["metrics"]> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" || typeof value === "string") {
      picked[key] = value;
    } else if (key === "stage_metrics" && isObject(value)) {
      picked[key] = value as Record<string, Record<string, number>>;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * Join recorded execution_states.metrics onto step_outcomes by step_id, in place.
 *
 * fail-open: any store-read error leaves stepOutcomes untouched. buildRunSummary's
 * never-throws contract is preserved (mirrors extractContextProvenance).
 */
function joinRecordedMetrics(workspacePath: string, stepOutcomes: StepOutcome[]): void {
  try {
    const store = getExecutionStore(workspacePath);
    const metricsByState = new Map(store.getAllStates().map((s) => [s.state_id, s.metrics]));
    for (const step of stepOutcomes) {
      const raw = metricsByState.get(step.step_id);
      if (!raw) continue;
      const picked = pickArchivableMetrics(raw);
      if (picked) step.metrics = picked;
    }
  } catch {
    // fail-open — buildRunSummary never throws (mirrors extractContextProvenance)
  }
}

/**
 * Extract review results from a `reviews/` directory beside `workspacePath`.
 *
 * Parses YAML frontmatter and violation/honored sections from every `.md` file.
 * Returns an empty array when `reviews/` is missing or unreadable; individual
 * unreadable files are skipped. Never throws.
 *
 * Exported so `scripts/backfill-review-extraction.ts` can re-derive `review_results`
 * for already-archived runs through the SAME extractor that runs at archive time.
 * Archive directories mirror the workspace layout (`reviews/` beside
 * `run-summary.json`), so it runs unmodified against an archive path. A second
 * copy of this parsing would re-create the drift this build repairs
 * (`single-source-of-truth`).
 */
export function extractReviewResults(workspacePath: string): ReviewResult[] {
  const reviewsDir = join(workspacePath, "reviews");
  if (!existsSync(reviewsDir)) {
    return [];
  }

  const results: ReviewResult[] = [];
  let entries: string[] = [];

  try {
    entries = readdirSync(reviewsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(reviewsDir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = parseReviewFile(content);
      if (result !== null) {
        results.push(result);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Build artifact inventory — counts files per directory and lists top-level files.
 * Scans the workspace root for directories and files.
 */
function buildArtifactInventory(workspacePath: string): ArtifactInventory {
  const directories: { name: string; file_count: number }[] = [];
  const files: string[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(workspacePath);
  } catch {
    return { directories, files, total_files: 0 };
  }

  for (const entry of entries) {
    const entryPath = join(workspacePath, entry);
    try {
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        const fileCount = countFilesInDir(entryPath);
        if (fileCount > 0) {
          directories.push({ file_count: fileCount, name: entry });
        }
      } else if (stat.isFile()) {
        files.push(entry);
      }
    } catch {
      // Skip unreadable entries
    }
  }

  const total_files = directories.reduce((sum, d) => sum + d.file_count, 0) + files.length;
  return { directories, files, total_files };
}

// ---- Private helpers ----

/**
 * Build a step_id → latest agent_id lookup from back-fill events.
 * Latest event for a given step_id wins (map is overwritten in iteration order).
 */
function buildAgentByStepMap(
  backfills: ReturnType<ReturnType<typeof getExecutionStore>["getEventsByType"]>,
): Map<string, string> {
  const agentByStep = new Map<string, string>();
  for (const ev of backfills) {
    const sid = ev.payload.step_id;
    const aid = ev.payload.agent_id;
    if (typeof sid === "string" && typeof aid === "string") {
      agentByStep.set(sid, aid);
    }
  }
  return agentByStep;
}

/**
 * Map a single context_provenance event payload to a ContextProvenanceSummary.
 * Joins agent_id from the back-fill map (back-fill wins; falls back to inline; then null).
 */
function mapProvenanceEvent(
  ev: ReturnType<ReturnType<typeof getExecutionStore>["getEventsByType"]>[number],
  agentByStep: Map<string, string>,
): ContextProvenanceSummary {
  const p = ev.payload as Record<string, unknown>;
  const stepId = typeof p.step_id === "string" ? p.step_id : null;
  const artifacts = Array.isArray(p.assembled_artifacts)
    ? (p.assembled_artifacts as AssembledArtifact[])
    : [];

  // Join: back-fill agent_id wins; fall back to inline agent_id in the event; then null.
  const joinedAgentId =
    (stepId !== null ? agentByStep.get(stepId) : undefined) ??
    (typeof p.agent_id === "string" ? p.agent_id : null);

  return {
    agent_id: joinedAgentId ?? null,
    agent_name: typeof p.agent_name === "string" ? p.agent_name : "",
    artifact_count: artifacts.length,
    artifacts,
    spawned_at: typeof p.spawned_at === "string" ? p.spawned_at : "",
    step_id: stepId,
  };
}

/**
 * Extract context provenance summaries from the workspace's execution store.
 *
 * Reads `context_provenance` events and joins `agent_id` from
 * `context_provenance_agent_id` back-fill events (latest back-fill wins per step_id).
 *
 * fail-open: any read or parse error returns []. buildRunSummary's never-throws
 * contract is preserved.
 *
 * bounded-context-boundaries: reads via getExecutionStore (live cached connection —
 * sees WAL-buffered rows). Do NOT open a second read-only handle.
 */
function extractContextProvenance(workspacePath: string): ContextProvenanceSummary[] {
  try {
    const store = getExecutionStore(workspacePath);
    const provEvents = store.getEventsByType("context_provenance");
    const backfills = store.getEventsByType("context_provenance_agent_id");
    const agentByStep = buildAgentByStepMap(backfills);
    return provEvents.map((ev) => mapProvenanceEvent(ev, agentByStep));
  } catch {
    // Fail-open: provenance summary is best-effort; buildRunSummary must never throw.
    return [];
  }
}

/**
 * Convert a raw journal step object to a StepOutcome.
 * Missing/null fields default to null.
 */
function stepToOutcome(raw: unknown): StepOutcome {
  if (!isObject(raw)) {
    return {
      agent_type: "",
      artifacts_expected: [],
      completed_at: null,
      duration_ms: null,
      started_at: null,
      status: "",
      step_id: "",
    };
  }

  const obj = raw as Record<string, unknown>;
  const startedAt = typeof obj.started_at === "string" ? obj.started_at : null;
  const completedAt = typeof obj.completed_at === "string" ? obj.completed_at : null;

  let durationMs: number | null = null;
  if (startedAt !== null && completedAt !== null) {
    try {
      durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    } catch {
      durationMs = null;
    }
  }

  return {
    agent_type: typeof obj.agent_type === "string" ? obj.agent_type : "",
    artifacts_expected: Array.isArray(obj.artifacts_expected)
      ? (obj.artifacts_expected as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    completed_at: completedAt,
    duration_ms: durationMs,
    started_at: startedAt,
    status: typeof obj.status === "string" ? obj.status : "",
    step_id: typeof obj.step_id === "string" ? obj.step_id : "",
  };
}

/**
 * Count all files in a directory (non-recursive, top-level only).
 */
function countFilesInDir(dirPath: string): number {
  try {
    const entries = readdirSync(dirPath);
    let count = 0;
    for (const entry of entries) {
      try {
        const stat = statSync(join(dirPath, entry));
        if (stat.isFile()) count++;
      } catch {
        // Skip unreadable entries
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Compute timing from step outcomes.
 * Returns the earliest started_at and latest completed_at across all steps.
 */
function computeTiming(steps: StepOutcome[]): {
  startedAt: string | null;
  completedAt: string | null;
  totalDurationMs: number | null;
} {
  if (steps.length === 0) {
    return { completedAt: null, startedAt: null, totalDurationMs: null };
  }

  const { startedAt, completedAt } = computeTimeBounds(steps);
  const totalDurationMs = calcDurationMs(startedAt, completedAt);
  return { completedAt, startedAt, totalDurationMs };
}

/** Scan step outcomes for the earliest started_at and latest completed_at. */
function computeTimeBounds(steps: StepOutcome[]): {
  startedAt: string | null;
  completedAt: string | null;
} {
  let startedAt: string | null = null;
  let completedAt: string | null = null;

  for (const step of steps) {
    if (step.started_at !== null && (startedAt === null || step.started_at < startedAt)) {
      startedAt = step.started_at;
    }
    if (step.completed_at !== null && (completedAt === null || step.completed_at > completedAt)) {
      completedAt = step.completed_at;
    }
  }

  return { completedAt, startedAt };
}

/** Compute duration in milliseconds between two ISO timestamps. Returns null on error. */
function calcDurationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  try {
    return new Date(completedAt).getTime() - new Date(startedAt).getTime();
  } catch {
    return null;
  }
}

/** Type guard for plain objects. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
