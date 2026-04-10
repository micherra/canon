/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  accumulateCannotFix,
  appendConcern,
  completeState,
  setBlocked,
} from "@domains/board/board.ts";
import { syncBoardToStore } from "@domains/board/board-sync.ts";
import type { Board, StateId, WorkspacePath } from "@domains/flows/board-state-schemas.ts";
import { stateId as mkStateId } from "@domains/flows/board-state-schemas.ts";
import type {
  BaselineEvidence,
  DiscoveredGate,
  GateResult,
  PostconditionAssertion,
  PostconditionResult,
  RequiredArtifact,
  ResolvedFlow,
  StateDefinition,
  StuckWhen,
  TestResults,
  ViolationSeverities,
} from "@domains/flows/flow-definition-schemas.ts";
import {
  BaselineEvidenceSchema,
  STATUS_ALIASES,
  STATUS_KEYWORDS,
} from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { isPathContained, isPathInWorktree } from "@shared/lib/worktree-guard.ts";
import { inspectDebateProgress } from "../engine/debate.ts";
import { executeEffects } from "../engine/effects.ts";
import {
  aggregateParallelPerResults,
  aggregateReviewResults,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  evaluateTransition,
  isRoleOptional,
  isStuck,
  normalizeStatus,
} from "../engine/transitions.ts";

// Status consistency check (argu-02)

/** Statuses that imply success — blocked when test_results.failed > 0 without baseline evidence. */
const SUCCESS_STATUSES = new Set([
  "done",
  "done_with_concerns", // CRITICAL: agents cannot use concerns to bypass
  "fixed",
  "partial_fix",
  "all_passing",
  "findings",
  "clean",
  "updated",
  "no_updates",
  "epic_complete",
  "approved",
]);

// Artifact validation (ADR-010)

type MetaJson = {
  _type: string;
  _version: number;
  [key: string]: unknown;
};

/**
 * Validates that all required artifacts exist and have the correct _type in
 * their .meta.json sidecar files. Searches both the reported artifacts list
 * and common locations (reviews/ and plans/ subdirectories).
 *
 * Returns toolError("INVALID_INPUT") when any required artifact is missing
 * or has the wrong type. Returns null when all artifacts are valid.
 *
 * Honors errors-are-values: never throws; all errors returned as ToolResult.
 */
function matchesArtifactName(artifactPath: string, reqName: string, metaName: string): boolean {
  const b = basename(artifactPath);
  if (b === metaName || artifactPath.endsWith(metaName)) return true;
  for (const ext of [".md", ".txt", ".json"]) {
    if (b === `${reqName}${ext}` || artifactPath.endsWith(`${reqName}${ext}`)) return true;
  }
  return false;
}

async function validateMatchedArtifact(
  workspace: WorkspacePath,
  match: string,
  req: RequiredArtifact,
): Promise<ToolResult<void> | null> {
  const fullPath = isAbsolute(match) ? match : join(workspace, match);
  // Two-layer workspace boundary check (ADR-014a).
  // Layer 1: logical containment (no .. traversal) — always enforced, no filesystem I/O.
  if (!isPathContained(workspace, fullPath)) {
    return toolError("INVALID_INPUT", `Artifact path "${match}" resolves outside workspace`);
  }
  // Layer 2: symlink resolution via realpath — catches symlink-based escapes for paths
  // that exist on disk. When the path does not yet exist (realpath fails), layer 1 suffices.
  const guard = await isPathInWorktree(fullPath, workspace);
  if (!guard.ok && guard.message.includes("via symlink")) {
    return toolError("INVALID_INPUT", `Artifact path "${match}" resolves outside workspace`);
  }
  const metaPath = fullPath.endsWith(".meta.json")
    ? fullPath
    : fullPath.replace(/\.(md|txt|json)$/, ".meta.json");
  try {
    const content = await readFile(metaPath, "utf-8");
    const meta: MetaJson = JSON.parse(content);
    if (meta._type !== req.type) {
      return toolError(
        "INVALID_INPUT",
        `Artifact "${req.name}" has type "${meta._type}" but expected "${req.type}"`,
      );
    }
  } catch {
    return toolError(
      "INVALID_INPUT",
      `Required artifact "${req.name}" meta file not readable at "${metaPath}"`,
    );
  }
  return null;
}

async function validateMetaAtPath(
  filePath: string,
  req: RequiredArtifact,
  location: string,
): Promise<{ found: boolean; error: ToolResult<void> | null }> {
  try {
    const content = await readFile(filePath, "utf-8");
    try {
      const meta: MetaJson = JSON.parse(content);
      if (meta._type !== req.type) {
        return {
          error: toolError(
            "INVALID_INPUT",
            `Artifact "${req.name}" has type "${meta._type}" but expected "${req.type}"`,
          ),
          found: false,
        };
      }
      return { error: null, found: true };
    } catch {
      return {
        error: toolError(
          "INVALID_INPUT",
          `Artifact "${req.name}" found at ${location} but contains malformed JSON`,
        ),
        found: false,
      };
    }
  } catch {
    return { error: null, found: false };
  }
}

async function searchPlansForArtifact(
  workspace: WorkspacePath,
  metaName: string,
  req: RequiredArtifact,
): Promise<{ found: boolean; error: ToolResult<void> | null }> {
  const plansDir = join(workspace, "plans");
  const subdirs = await readdir(plansDir).catch(() => [] as string[]);
  for (const sub of subdirs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential scan with early-exit — cannot parallelize without losing short-circuit semantics
    const result = await validateMetaAtPath(
      join(plansDir, sub, metaName),
      req,
      `plans/${sub}/${metaName}`,
    );
    if (result.error) return result;
    if (result.found) return { error: null, found: true };
  }
  return { error: null, found: false };
}

async function validateSingleArtifact(
  workspace: WorkspacePath,
  artifacts: string[],
  req: RequiredArtifact,
): Promise<ToolResult<void> | null> {
  const metaName = `${req.name}.meta.json`;
  const match = artifacts.find((a) => matchesArtifactName(a, req.name, metaName));

  if (match) return validateMatchedArtifact(workspace, match, req);

  const reviewResult = await validateMetaAtPath(
    join(workspace, "reviews", metaName),
    req,
    `reviews/${metaName}`,
  );
  if (reviewResult.error) return reviewResult.error;
  if (reviewResult.found) return null;

  const plansResult = await searchPlansForArtifact(workspace, metaName, req);
  if (plansResult.error) return plansResult.error;
  if (plansResult.found) return null;

  return toolError(
    "INVALID_INPUT",
    `Required artifact "${req.name}" not found. Expected .meta.json sidecar with type "${req.type}"`,
  );
}

export async function validateRequiredArtifacts(
  workspace: WorkspacePath,
  artifacts: string[],
  required: RequiredArtifact[],
): Promise<ToolResult<void> | null> {
  for (const req of required) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential validation with early-exit on first error — cannot parallelize without losing short-circuit semantics
    const err = await validateSingleArtifact(workspace, artifacts, req);
    if (err) return err;
  }
  return null;
}

/**
 * Validates required handoff files declared on a state definition (ADR-018).
 *
 * Unlike validateRequiredArtifacts, this is non-blocking: missing or mistyped
 * handoffs produce warning strings rather than ToolResult errors. Returns an
 * array of warning strings (empty when all handoffs are present and correct).
 * Never throws.
 */
async function validateHandoffEntry(workspace: WorkspacePath, req: RequiredArtifact): Promise<string[]> {
  const metaPath = join(workspace, "handoffs", `${req.name}.meta.json`);
  let content: string;
  try {
    content = await readFile(metaPath, "utf-8");
  } catch {
    return [`Required handoff "${req.name}" not found in handoffs/`];
  }
  // Symlink guard (ADR-018 security follow-up): after confirming the file exists,
  // verify it doesn't escape the workspace via symlink resolution.
  const symlinkGuard = await isPathInWorktree(metaPath, workspace);
  if (!symlinkGuard.ok && symlinkGuard.message.includes("via symlink")) {
    return [`Required handoff "${req.name}" resolves outside workspace via symlink`];
  }
  try {
    const meta: MetaJson = JSON.parse(content);
    if (meta._type !== req.type) {
      return [`Required handoff "${req.name}" has type "${meta._type}" but expected "${req.type}"`];
    }
    return [];
  } catch {
    return [`Required handoff "${req.name}" has malformed JSON in handoffs/`];
  }
}

export async function validateRequiredHandoffs(
  workspace: WorkspacePath,
  required: RequiredArtifact[],
): Promise<string[]> {
  const perEntry = await Promise.all(required.map((req) => validateHandoffEntry(workspace, req)));
  return perEntry.flat();
}

// Pure board mutation helpers — extracted to reduce transaction complexity

function updateBoardStateField(
  board: Board,
  stateId: StateId,
  fields: Record<string, unknown>,
): Board {
  if (!board.states[stateId]) return board;
  return {
    ...board,
    states: {
      ...board.states,
      [stateId]: { ...board.states[stateId], ...fields },
    },
  };
}

function enrichBoardMetrics(
  board: Board,
  input: {
    state_id: StateId;
    metrics?: Record<string, unknown>;
    gate_results?: GateResult[];
    postcondition_results?: PostconditionResult[];
    violation_count?: number;
    violation_severities?: ViolationSeverities;
    test_results?: TestResults;
    files_changed?: number;
  },
): Board {
  const hasCallerMetrics =
    input.metrics != null ||
    input.gate_results?.length ||
    input.postcondition_results?.length ||
    input.violation_count != null ||
    input.violation_severities != null ||
    input.test_results != null ||
    input.files_changed != null;

  if (!hasCallerMetrics || !board.states[input.state_id]) return board;

  const currentMetrics = board.states[input.state_id]?.metrics ?? {};
  const enrichedMetrics = {
    ...currentMetrics,
    ...(input.metrics ?? {}),
    ...(input.gate_results?.length ? { gate_results: input.gate_results } : {}),
    ...(input.postcondition_results?.length
      ? { postcondition_results: input.postcondition_results }
      : {}),
    ...(input.violation_count != null ? { violation_count: input.violation_count } : {}),
    ...(input.violation_severities ? { violation_severities: input.violation_severities } : {}),
    ...(input.test_results ? { test_results: input.test_results } : {}),
    ...(input.files_changed != null ? { files_changed: input.files_changed } : {}),
    ...(board.iterations[input.state_id]
      ? { revision_count: board.iterations[input.state_id].count }
      : {}),
  };

  return updateBoardStateField(board, input.state_id, { metrics: enrichedMetrics });
}

function applyResultFields(
  board: Board,
  stateId: StateId,
  gateResults?: GateResult[],
  postconditionResults?: PostconditionResult[],
): Board {
  let result = board;
  if (gateResults?.length)
    result = updateBoardStateField(result, stateId, { gate_results: gateResults });
  if (postconditionResults?.length)
    result = updateBoardStateField(result, stateId, {
      postcondition_results: postconditionResults,
    });
  return result;
}

function applyDiscoveredItems(
  board: Board,
  stateId: StateId,
  gates?: DiscoveredGate[],
  postconditions?: PostconditionAssertion[],
): Board {
  let result = board;
  if (gates?.length && result.states[stateId]) {
    result = updateBoardStateField(result, stateId, {
      discovered_gates: [...(result.states[stateId].discovered_gates ?? []), ...gates],
    });
  }
  if (postconditions?.length && result.states[stateId]) {
    result = updateBoardStateField(result, stateId, {
      discovered_postconditions: [
        ...(result.states[stateId].discovered_postconditions ?? []),
        ...postconditions,
      ],
    });
  }
  return result;
}

function applyCompeteResults(
  board: Board,
  stateId: StateId,
  competeResults?: Array<{ lens?: string; status: string; artifacts?: string[] }>,
  synthesized?: boolean,
): Board {
  if (competeResults?.length && board.states[stateId]) {
    return updateBoardStateField(board, stateId, {
      compete_results: competeResults,
      ...(synthesized != null ? { synthesized } : {}),
    });
  }
  if (synthesized != null && board.states[stateId]) {
    return updateBoardStateField(board, stateId, { synthesized });
  }
  return board;
}

function applyDiscoveries(
  board: Board,
  stateId: StateId,
  input: {
    gate_results?: GateResult[];
    postcondition_results?: PostconditionResult[];
    discovered_gates?: DiscoveredGate[];
    discovered_postconditions?: PostconditionAssertion[];
    compete_results?: Array<{ lens?: string; status: string; artifacts?: string[] }>;
    synthesized?: boolean;
  },
): Board {
  let result = applyResultFields(board, stateId, input.gate_results, input.postcondition_results);
  result = applyDiscoveredItems(
    result,
    stateId,
    input.discovered_gates,
    input.discovered_postconditions,
  );
  return applyCompeteResults(result, stateId, input.compete_results, input.synthesized);
}

function collectOptionalRoles(
  roles?: Array<string | { name: string; optional?: boolean }>,
): Set<string> {
  const result = new Set<string>();
  if (!roles) return result;
  for (const roleEntry of roles) {
    if (isRoleOptional(roleEntry)) {
      result.add(typeof roleEntry === "string" ? roleEntry : roleEntry.name);
    }
  }
  return result;
}

function aggregateParallelResultsOnBoard(
  board: Board,
  stateId: StateId,
  parallelResults: Array<{ item: string; status: string; artifacts?: string[] }>,
  stateDef: { roles?: Array<string | { name: string; optional?: boolean }> } | undefined,
): { board: Board; condition: string } {
  const isReviewAgg = parallelResults.every((r) =>
    ["clean", "warning", "blocking"].includes(r.status.toLowerCase()),
  );
  const optionalRoles = collectOptionalRoles(stateDef?.roles);
  const aggregated = isReviewAgg
    ? aggregateReviewResults(parallelResults)
    : aggregateParallelPerResults(
        parallelResults,
        optionalRoles.size > 0 ? optionalRoles : undefined,
      );

  let result = updateBoardStateField(board, stateId, { parallel_results: parallelResults });

  if (aggregated.cannotFixItems.length > 0 && result.iterations[stateId]) {
    const iteration = result.iterations[stateId];
    result = {
      ...result,
      iterations: {
        ...result.iterations,
        [stateId]: { ...iteration, cannot_fix: iteration.cannot_fix ?? [] },
      },
    };
  }

  return { board: result, condition: aggregated.condition };
}

type DetectStuckOptions = {
  condition: string;
  stateDef: { stuck_when?: StuckWhen } | undefined;
  input: {
    principle_ids?: string[];
    file_paths?: string[];
    file_test_pairs?: Array<{ file: string; test: string }>;
    commit_sha?: string;
    artifact_count?: number;
  };
  store: ReturnType<typeof getExecutionStore>;
};

function detectStuck(
  board: Board,
  stateId: StateId,
  options: DetectStuckOptions,
): { board: Board; stuck: boolean; stuck_reason?: string } {
  const { condition, stateDef, input, store } = options;
  if (!stateDef?.stuck_when || !board.iterations[stateId]) {
    return { board, stuck: false };
  }
  const iteration = board.iterations[stateId];
  const historyEntry = buildHistoryEntry(stateDef.stuck_when, {
    artifactCount: input.artifact_count,
    commitSha: input.commit_sha,
    filePaths: input.file_paths,
    pairs: input.file_test_pairs,
    principleIds: input.principle_ids,
    status: condition,
  });
  const iterationData: Record<string, unknown> = {
    status: condition,
    ...(input.principle_ids ? { principle_ids: input.principle_ids } : {}),
    ...(input.file_paths ? { file_paths: input.file_paths } : {}),
    ...(input.file_test_pairs ? { pairs: input.file_test_pairs } : {}),
    ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
    ...(input.artifact_count != null ? { artifact_count: input.artifact_count } : {}),
  };
  store.recordIterationResult(stateId, iteration.count, condition, iterationData);
  const updatedHistory = [...iteration.history, historyEntry];
  const updatedBoard = {
    ...board,
    iterations: { ...board.iterations, [stateId]: { ...iteration, history: updatedHistory } },
  };

  if (isStuck(updatedHistory, stateDef.stuck_when)) {
    return {
      board: updatedBoard,
      stuck: true,
      stuck_reason: `Agent is stuck in state '${stateId}' (${stateDef.stuck_when})`,
    };
  }
  return { board: updatedBoard, stuck: false };
}

function applyDebateResult(
  board: Board,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>>,
  stateId: StateId,
  debate: NonNullable<ResolvedFlow["debate"]>,
): { board: Board; nextState: string | null; hitl_required: boolean; hitl_reason?: string } {
  const updatedBoard = {
    ...board,
    metadata: {
      ...(board.metadata ?? {}),
      debate_completed: debateResult.completed,
      debate_last_round: debateResult.last_completed_round,
      ...(debateResult.summary ? { debate_summary: debateResult.summary } : {}),
    },
  };
  if (!debateResult.completed)
    return { board: updatedBoard, hitl_required: false, nextState: stateId };
  if (debate.hitl_checkpoint) {
    return {
      board: updatedBoard,
      hitl_reason: `Debate completed after round ${debateResult.last_completed_round}${debateResult.convergence?.reason ? `: ${debateResult.convergence.reason}` : ""}`,
      hitl_required: true,
      nextState: null,
    };
  }
  return { board: updatedBoard, hitl_required: false, nextState: null };
}

function resolveCondition(
  board: Board,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][StateId] | undefined,
): { board: Board; condition: string } {
  let condition = normalizeStatus(input.status_keyword);

  if (input.flow.review_threshold && stateDef?.transitions) {
    condition = applyReviewThresholdToCondition(
      input.flow.review_threshold,
      condition,
      stateDef.transitions,
    );
  }

  if (input.parallel_results && input.parallel_results.length > 0) {
    const agg = aggregateParallelResultsOnBoard(
      board,
      input.state_id,
      input.parallel_results,
      stateDef,
    );
    return { board: agg.board, condition: agg.condition };
  }

  return { board, condition };
}

type FinalizeTransitionOptions = {
  stateId: StateId;
  condition: string;
  statusKeyword: string;
  stateType: string | undefined;
  nextState: string | null;
  stuckResult: { stuck: boolean; stuck_reason?: string };
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

function finalizeTransition(
  board: Board,
  options: FinalizeTransitionOptions,
): { board: Board; hitl_required: boolean; hitl_reason?: string } {
  const { stateId, condition, statusKeyword, stateType, nextState, stuckResult } = options;
  let { hitl_required, hitl_reason } = options;
  const resolved = resolveHitl({
    condition,
    nextState,
    priorHitl: { reason: hitl_reason, required: hitl_required },
    stateId,
    stateType,
    statusKeyword,
    stuck: stuckResult.stuck,
    stuckReason: stuckResult.stuck_reason,
  });
  hitl_required = resolved.hitl_required;
  hitl_reason = resolved.hitl_reason;
  let result = board;
  if (resolved.board_blocked) result = setBlocked(result, stateId, hitl_reason!);
  if (hitl_required && hitl_reason && result.blocked == null && stateType !== "terminal") {
    result = setBlocked(result, stateId, hitl_reason);
  }
  if (nextState && nextState !== "hitl") result = { ...result, current_state: mkStateId(nextState) };
  return { board: result, hitl_reason, hitl_required };
}

type ResolveHitlOptions = {
  stuck: boolean;
  stuckReason: string | undefined;
  nextState: string | null;
  stateId: StateId;
  condition: string;
  statusKeyword: string;
  stateType: string | undefined;
  priorHitl: { required: boolean; reason?: string };
};

function resolveHitl(options: ResolveHitlOptions): {
  hitl_required: boolean;
  hitl_reason?: string;
  board_blocked: boolean;
} {
  const { stuck, stuckReason, nextState, stateId, condition, statusKeyword, stateType, priorHitl } =
    options;
  if (priorHitl.required)
    return { board_blocked: false, hitl_reason: priorHitl.reason, hitl_required: true };
  if (stuck) return { board_blocked: false, hitl_reason: stuckReason, hitl_required: true };
  if (nextState === "hitl") {
    return {
      board_blocked: false,
      hitl_reason: `Transition from '${stateId}' on '${condition}' leads to hitl`,
      hitl_required: true,
    };
  }
  if (nextState === null && stateType !== "terminal") {
    const lowered = statusKeyword.toLowerCase();
    const isRecognized =
      (STATUS_KEYWORDS as readonly string[]).includes(lowered) || lowered in STATUS_ALIASES;
    const reason = isRecognized
      ? `No matching transition from '${stateId}' for condition '${condition}'`
      : `Unrecognized status keyword '${statusKeyword}' from state '${stateId}' (normalized to '${condition}')`;
    return { board_blocked: true, hitl_reason: reason, hitl_required: true };
  }
  return { board_blocked: false, hitl_required: false };
}

type ReportResultInput = {
  workspace: WorkspacePath;
  state_id: StateId;
  status_keyword: string;
  flow: ResolvedFlow;
  artifacts?: string[];
  concern_text?: string;
  error?: string;
  metrics?: {
    duration_ms: number;
    spawns: number;
    model: string;
    // ADR-003a agent performance metrics (all optional for backward compat)
    tool_calls?: number;
    orientation_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    turns?: number;
  };
  parallel_results?: Array<{
    item: string;
    status: string;
    artifacts?: string[];
  }>;
  // Stuck detection data — callers must provide these for non-same_status strategies
  principle_ids?: string[];
  file_paths?: string[];
  file_test_pairs?: Array<{ file: string; test: string }>;
  commit_sha?: string;
  artifact_count?: number;
  // Quality gate results reported by the agent
  gate_results?: GateResult[];
  postcondition_results?: PostconditionResult[];
  violation_count?: number;
  violation_severities?: ViolationSeverities;
  test_results?: TestResults;
  files_changed?: number;
  // Discovery fields — agents report what gate commands and postconditions they discovered
  discovered_gates?: DiscoveredGate[];
  discovered_postconditions?: PostconditionAssertion[];
  // Compete results — persisted to board state for synthesizer access
  compete_results?: Array<{ lens?: string; status: string; artifacts?: string[] }>;
  synthesized?: boolean;
  // Baseline evidence for pre-existing test failures (argu-02)
  baseline_evidence?: BaselineEvidence;
  // Optional progress line to append to progress.md (saves a separate Write call)
  progress_line?: string;
  // Project directory for drift effect persistence
  project_dir?: string;
  // ADR-015: path to the agent transcript JSONL file (best-effort persistence)
  transcript_path?: string;
};

export type LogEntry = {
  state_id: string;
  status_keyword: string;
  normalized_condition: string;
  next_state: string | null;
  stuck: boolean;
  hitl_required: boolean;
  timestamp: string;
  artifacts?: string[];
  error?: string;
  metrics?: {
    duration_ms: number;
    spawns: number;
    model: string;
    tool_calls?: number;
    orientation_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    turns?: number;
  };
  stuck_reason?: string;
  hitl_reason?: string;
  // Quality signal fields
  gate_results?: GateResult[];
  postcondition_results?: PostconditionResult[];
  violation_count?: number;
  violation_severities?: ViolationSeverities;
  test_results?: TestResults;
  files_changed?: number;
  discovered_gates_count?: number;
  discovered_postconditions_count?: number;
};

export type ReportResultResult = {
  transition_condition: string;
  next_state: string | null;
  board: Board;
  stuck: boolean;
  stuck_reason?: string;
  hitl_required: boolean;
  hitl_reason?: string;
  log_entry: LogEntry;
  /** Set when pre-existing test failures have been documented with baseline evidence. */
  escalate_to_hitl?: {
    reason: string;
    baseline_evidence: BaselineEvidence;
  };
  /** Non-blocking warnings for missing or mistyped handoff files (ADR-018). */
  warnings?: string[];
};

export async function reportResult(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  return reportResultLocked(input);
}

function checkTestResultConsistency(input: ReportResultInput): ToolResult<void> | null {
  if (!input.test_results || input.test_results.failed <= 0) return null;

  const rawStatusLower = input.status_keyword.toLowerCase();
  if (!SUCCESS_STATUSES.has(rawStatusLower)) return null;

  // Status implies success but test_results.failed > 0 — require baseline evidence
  if (!input.baseline_evidence) {
    return toolError(
      "INVALID_INPUT",
      `Status '${input.status_keyword}' reported with ${input.test_results.failed} test failure(s) but no baseline_evidence provided. ` +
        `Either fix all failures, provide baseline_evidence proving they pre-date your changes, ` +
        `or report IMPLEMENTATION_ISSUE/BLOCKED.`,
      true, // recoverable — agent can retry with correct status or provide evidence
    );
  }

  // Validate the baseline evidence schema
  const parseResult = BaselineEvidenceSchema.safeParse(input.baseline_evidence);
  if (!parseResult.success) {
    return toolError(
      "INVALID_INPUT",
      `baseline_evidence failed validation: ${parseResult.error.message}`,
      true,
    );
  }

  if (parseResult.data.new_failures.length > 0) {
    const { baseline_commit, new_failures } = parseResult.data;
    return toolError(
      "INVALID_INPUT",
      `Status '${input.status_keyword}' reported but baseline_evidence shows ${new_failures.length} NEW test failure(s) ` +
        `not present at ${baseline_commit}: ${new_failures.join(", ")}. ` +
        `Fix new failures or report IMPLEMENTATION_ISSUE.`,
      true,
    );
  }

  return null; // All failures are pre-existing — proceed to success with escalation
}

async function validatePreTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][StateId] | undefined,
): Promise<ToolResult<void> | null> {
  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }

  // Consistency check: status/test-result alignment (argu-02)
  const consistencyError = checkTestResultConsistency(input);
  if (consistencyError) return consistencyError;

  if (stateDef?.required_artifacts?.length) {
    const validationError = await validateRequiredArtifacts(
      input.workspace,
      input.artifacts ?? [],
      stateDef.required_artifacts,
    );
    if (validationError) return validationError;
  }
  return null;
}

/**
 * Applies state completion to board, using completeState when the state is in_progress,
 * or falling back to a direct board mutation for states not yet in_progress.
 * Backward compat: reportResult may be called without a prior enterState call.
 * We do NOT call enterState here to avoid incrementing the iteration count as a side-effect.
 */
function applyStateCompletion(
  board: Board,
  stateId: StateId,
  condition: string,
  artifacts: string[] | undefined,
): Board {
  const completeResult = completeState(board, stateId, condition, artifacts);
  if (!completeResult.ok) {
    const now = new Date().toISOString();
    const prev = board.states[stateId];
    const updated = {
      ...(prev ?? { entries: 0 }),
      completed_at: now,
      result: condition,
      status: "done" as const,
      ...(artifacts ? { artifacts } : {}),
    };
    return { ...board, last_updated: now, states: { ...board.states, [stateId]: updated } };
  }
  return completeResult.board;
}

type ApplyStuckOptions = {
  board: Board;
  stateId: StateId;
  condition: string;
  nextState: string | null;
  input: ReportResultInput;
  stateDef: ResolvedFlow["states"][StateId] | undefined;
  store: ReturnType<typeof getExecutionStore>;
};

/**
 * Runs stuck detection and, when condition is cannot_fix, accumulates cannot_fix items.
 * Returns updated board, next state (nulled if stuck), and the stuck result metadata.
 */
function applyStuckAndCannotFix(options: ApplyStuckOptions): {
  board: Board;
  nextState: string | null;
  stuckResult: ReturnType<typeof detectStuck>;
} {
  const { board, stateId, condition, nextState, input, stateDef, store } = options;
  const stuckResult = detectStuck(board, stateId, { condition, input, stateDef, store });
  let result = stuckResult.board;
  const resolvedNext = stuckResult.stuck ? null : nextState;

  if (condition === "cannot_fix" && input.principle_ids && input.file_paths) {
    result = accumulateCannotFix(result, stateId, input.principle_ids, input.file_paths);
  }
  return { board: result, nextState: resolvedNext, stuckResult };
}

type DebateHitl = {
  board: Board;
  nextState: string | null;
  hitl_required: boolean;
  hitl_reason?: string;
};

type ApplyDebateHitlOptions = {
  board: Board;
  debate: ResolvedFlow["debate"];
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  nextState: string | null;
  stateId: StateId;
};

function applyDebateHitl(options: ApplyDebateHitlOptions): DebateHitl {
  const { board, debate, debateResult, nextState, stateId } = options;
  if (debateResult === undefined) return { board, hitl_required: false, nextState };
  const dr = applyDebateResult(board, debateResult, stateId, debate!);
  return {
    board: dr.board,
    hitl_reason: dr.hitl_reason,
    hitl_required: dr.hitl_required,
    nextState: dr.nextState,
  };
}

/**
 * Applies concern note, state completion, metrics enrichment, and discovery fields to the board.
 * Pure pipeline over the board — no store I/O.
 */
function applyBoardMutations(
  board: Board,
  input: ReportResultInput,
  condition: string,
  stateDef: ResolvedFlow["states"][StateId] | undefined,
): Board {
  let result = board;
  if (input.status_keyword.toLowerCase() === "done_with_concerns" && input.concern_text) {
    result = appendConcern(
      result,
      input.state_id,
      stateDef?.agent ?? input.state_id,
      input.concern_text,
    );
  }
  result = applyStateCompletion(result, input.state_id, condition, input.artifacts);
  result = enrichBoardMetrics(result, input);
  return applyDiscoveries(result, input.state_id, input);
}

function executeReportTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][StateId] | undefined,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): TransactionResult {
  return store.transaction((): TransactionResult => {
    let board = store.getBoard();
    if (!board) throw new Error(`No execution found in workspace: ${input.workspace}`);

    const { board: b1, condition } = resolveCondition(board, input, stateDef);
    let nextState: string | null = stateDef ? evaluateTransition(stateDef, condition) : null;

    board = applyBoardMutations(b1, input, condition, stateDef);

    const stuckAndFix = applyStuckAndCannotFix({
      board,
      condition,
      input,
      nextState,
      stateDef,
      stateId: input.state_id,
      store,
    });
    board = stuckAndFix.board;
    nextState = stuckAndFix.nextState;
    const { stuckResult } = stuckAndFix;

    const debate = applyDebateHitl({
      board,
      debate: input.flow.debate,
      debateResult,
      nextState,
      stateId: input.state_id,
    });
    board = debate.board;
    nextState = debate.nextState;

    const finalResult = finalizeTransition(board, {
      condition,
      hitl_reason: debate.hitl_reason,
      hitl_required: debate.hitl_required,
      nextState,
      stateId: input.state_id,
      stateType: stateDef?.type,
      statusKeyword: input.status_keyword,
      stuckResult,
    });
    board = finalResult.board;
    syncBoardToStore(store, board);

    return {
      board,
      condition,
      hitl_reason: finalResult.hitl_reason,
      hitl_required: finalResult.hitl_required,
      nextState,
      stuck: stuckResult.stuck,
      stuck_reason: stuckResult.stuck_reason,
    };
  });
}

async function reportResultLocked(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  const store = getExecutionStore(input.workspace);
  const stateDef = input.flow.states[input.state_id];

  const preError = await validatePreTransaction(store, input, stateDef);
  if (preError) return preError;

  // Determine HITL escalation signal for pre-existing failures (argu-02)
  // We know baseline_evidence is valid here (consistency check passed above)
  const escalateToHitl = computeEscalateToHitl(input);

  let debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  if (input.state_id === input.flow.entry && input.flow.debate) {
    debateResult = await inspectDebateProgress(input.workspace, input.flow.debate);
  }

  const txResult = executeReportTransaction(store, input, stateDef, debateResult);

  return postTransactionSideEffects({ escalateToHitl, input, stateDef, store, txResult });
}

/** Computes the escalate_to_hitl payload when baseline evidence confirms pre-existing failures. */
function computeEscalateToHitl(
  input: ReportResultInput,
): ReportResultResult["escalate_to_hitl"] | undefined {
  if (!input.test_results || input.test_results.failed <= 0) return undefined;
  if (!input.baseline_evidence) return undefined;

  const rawStatusLower = input.status_keyword.toLowerCase();
  if (!SUCCESS_STATUSES.has(rawStatusLower)) return undefined;

  // All failures are pre-existing (new_failures is empty — checked in validatePreTransaction)
  return {
    baseline_evidence: input.baseline_evidence,
    reason:
      `Status '${input.status_keyword}' reported with ${input.test_results.failed} pre-existing test failure(s) ` +
      `confirmed against baseline commit '${input.baseline_evidence.baseline_commit}'. ` +
      `Human review required before advancing.`,
  };
}

type TransactionResult = {
  board: Board;
  condition: string;
  nextState: string | null;
  stuck: boolean;
  stuck_reason: string | undefined;
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

async function postTransactionSideEffects({
  store,
  input,
  stateDef,
  txResult,
  escalateToHitl,
}: {
  store: ReturnType<typeof getExecutionStore>;
  input: ReportResultInput;
  stateDef: ResolvedFlow["states"][StateId] | undefined;
  txResult: TransactionResult;
  escalateToHitl?: ReportResultResult["escalate_to_hitl"];
}): Promise<ToolResult<ReportResultResult>> {
  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } = txResult;

  persistTranscriptPath(store, input);
  persistProgressLine(store, input.progress_line);
  await runDriftEffects(stateDef, input);
  emitStuckEvent(store, { board, input, stateDef, stuck, stuck_reason });
  emitReportEvents(store, { condition, hitl_reason, hitl_required, input, nextState });

  const handoffWarnings = stateDef?.required_handoffs
    ? await validateRequiredHandoffs(input.workspace, stateDef.required_handoffs)
    : [];

  const log_entry = buildLogEntry(input, {
    condition,
    hitl_reason,
    hitl_required,
    nextState,
    stuck,
    stuck_reason,
  });

  return {
    board,
    hitl_reason,
    hitl_required,
    log_entry,
    next_state: nextState,
    ok: true as const,
    stuck,
    stuck_reason,
    transition_condition: condition,
    ...(escalateToHitl ? { escalate_to_hitl: escalateToHitl } : {}),
    ...(handoffWarnings.length > 0 ? { warnings: handoffWarnings } : {}),
  };
}

function persistTranscriptPath(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
): void {
  if (!input.transcript_path) return;
  const transcriptsDir = resolve(input.workspace, "transcripts");
  const resolvedPath = resolve(input.transcript_path);
  const rel = relative(transcriptsDir, resolvedPath);
  if (!rel.startsWith("..") && resolve(transcriptsDir, rel) === resolvedPath) {
    store.setTranscriptPath(input.state_id, input.transcript_path);
  }
}

function persistProgressLine(store: ReturnType<typeof getExecutionStore>, line?: string): void {
  if (!line) return;
  try {
    store.appendProgress(line);
  } catch {
    /* best-effort */
  }
}

async function runDriftEffects(
  stateDef: ReturnType<typeof Object.values<Record<string, unknown>>>[number] | undefined,
  input: ReportResultInput,
): Promise<void> {
  const def = stateDef as { effects?: unknown[] } | undefined;
  if (!def?.effects?.length || !input.artifacts?.length) return;
  const projectDir = input.project_dir || process.env.CANON_PROJECT_DIR || process.cwd();
  await executeEffects(def as StateDefinition, {
    artifacts: input.artifacts,
    projectDir,
    workspace: input.workspace,
  }).catch(() => {
    /* best-effort */
  });
}

type EmitStuckEventOptions = {
  board: Board;
  input: ReportResultInput;
  stuck: boolean;
  stuck_reason: string | undefined;
  stateDef: { stuck_when?: StuckWhen } | undefined;
};

function emitStuckEvent(
  store: ReturnType<typeof getExecutionStore>,
  options: EmitStuckEventOptions,
): void {
  const { board, input, stuck, stuck_reason, stateDef } = options;
  if (!stuck || !stuck_reason) return;
  const correlationId = store.getCorrelationId();
  const history = board.iterations[input.state_id]?.history ?? [];
  const stuckPayload = {
    comparison: {
      current: history.length >= 1 ? (history[history.length - 1] as Record<string, unknown>) : {},
      previous: history.length >= 2 ? (history[history.length - 2] as Record<string, unknown>) : {},
    },
    iteration_count: history.length,
    reason: stuck_reason,
    stateId: input.state_id,
    strategy: stateDef?.stuck_when ?? "unknown",
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };
  try {
    store.appendEvent("stuck_detected", stuckPayload, correlationId ?? undefined);
  } catch {
    /* best-effort */
  }
  try {
    flowEventBus.emit("stuck_detected", stuckPayload);
  } catch {
    /* best-effort */
  }
}

type EmitReportEventsOptions = {
  input: ReportResultInput;
  condition: string;
  nextState: string | null;
  hitl_required: boolean;
  hitl_reason: string | undefined;
};

function emitReportEvents(
  store: ReturnType<typeof getExecutionStore>,
  options: EmitReportEventsOptions,
): void {
  const { input, condition, nextState, hitl_required, hitl_reason } = options;
  const correlationId = store.getCorrelationId();
  const onStateCompleted = (
    event: import("@domains/messages/events.js").FlowEventMap["state_completed"],
  ) => {
    try {
      store.appendEvent(
        "state_completed",
        event as Record<string, unknown>,
        correlationId ?? undefined,
      );
    } catch {
      /* best-effort */
    }
  };
  const onTransitionEvaluated = (
    event: import("@domains/messages/events.js").FlowEventMap["transition_evaluated"],
  ) => {
    try {
      store.appendEvent(
        "transition_evaluated",
        event as Record<string, unknown>,
        correlationId ?? undefined,
      );
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("state_completed", onStateCompleted);
  flowEventBus.once("transition_evaluated", onTransitionEvaluated);
  try {
    flowEventBus.emit("state_completed", {
      artifacts: input.artifacts ?? [],
      duration_ms: input.metrics?.duration_ms ?? 0,
      result: condition,
      stateId: input.state_id,
      timestamp: new Date().toISOString(),
      ...collectQualitySignals(input),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    flowEventBus.emit("transition_evaluated", {
      nextState: nextState ?? "null",
      normalizedCondition: condition,
      stateId: input.state_id,
      statusKeyword: input.status_keyword,
      timestamp: new Date().toISOString(),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    if (hitl_required) {
      flowEventBus.emit("hitl_triggered", {
        reason: hitl_reason ?? "unknown",
        stateId: input.state_id,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    flowEventBus.removeListener("state_completed", onStateCompleted);
    flowEventBus.removeListener("transition_evaluated", onTransitionEvaluated);
  }
}

function collectQualitySignals(input: ReportResultInput): Partial<LogEntry> {
  const signals: Partial<LogEntry> = {};
  if (input.gate_results?.length) signals.gate_results = input.gate_results;
  if (input.postcondition_results?.length)
    signals.postcondition_results = input.postcondition_results;
  if (input.violation_count != null) signals.violation_count = input.violation_count;
  if (input.violation_severities) signals.violation_severities = input.violation_severities;
  if (input.test_results) signals.test_results = input.test_results;
  if (input.files_changed != null) signals.files_changed = input.files_changed;
  if (input.discovered_gates?.length)
    signals.discovered_gates_count = input.discovered_gates.length;
  if (input.discovered_postconditions?.length)
    signals.discovered_postconditions_count = input.discovered_postconditions.length;
  return signals;
}

type BuildLogEntryOptions = {
  condition: string;
  nextState: string | null;
  stuck: boolean;
  hitl_required: boolean;
  stuck_reason?: string;
  hitl_reason?: string;
};

function buildLogEntry(input: ReportResultInput, options: BuildLogEntryOptions): LogEntry {
  const { condition, nextState, stuck, hitl_required, stuck_reason, hitl_reason } = options;
  return {
    hitl_required,
    next_state: nextState,
    normalized_condition: condition,
    state_id: input.state_id,
    status_keyword: input.status_keyword,
    stuck,
    timestamp: new Date().toISOString(),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(stuck_reason ? { stuck_reason } : {}),
    ...(hitl_reason ? { hitl_reason } : {}),
    ...collectQualitySignals(input),
  };
}
