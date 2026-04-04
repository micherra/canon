/**
 * MCP tool wrapper for reporting agent results and evaluating transitions.
 * Handles status normalization, transition evaluation, stuck detection,
 * and board state updates.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { completeState, setBlocked } from "../orchestration/board.ts";
import { syncBoardToStore } from "../orchestration/board-sync.ts";
import { inspectDebateProgress } from "../orchestration/debate.ts";
import { executeEffects } from "../orchestration/effects.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type {
  Board,
  CannotFixItem,
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
} from "../orchestration/flow-schema.ts";
import { STATUS_ALIASES, STATUS_KEYWORDS } from "../orchestration/flow-schema.ts";
import {
  aggregateParallelPerResults,
  aggregateReviewResults,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  evaluateTransition,
  isRoleOptional,
  isStuck,
  normalizeStatus,
} from "../orchestration/transitions.ts";
import type { ToolResult } from "../shared/lib/tool-result.ts";
import { toolError } from "../shared/lib/tool-result.ts";

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

function isPathTraversal(workspace: string, fullPath: string): boolean {
  const rel = relative(resolve(workspace), resolve(fullPath));
  return isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\");
}

async function validateMatchedArtifact(
  workspace: string,
  match: string,
  req: RequiredArtifact,
): Promise<ToolResult<void> | null> {
  const fullPath = isAbsolute(match) ? match : join(workspace, match);
  if (isPathTraversal(workspace, fullPath)) {
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
  workspace: string,
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
  workspace: string,
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
  workspace: string,
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

// Pure board mutation helpers — extracted to reduce transaction complexity

function updateBoardStateField(
  board: Board,
  stateId: string,
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
    state_id: string;
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
  stateId: string,
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
  stateId: string,
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
  stateId: string,
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
  stateId: string,
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

function accumulateCannotFix(
  board: Board,
  stateId: string,
  principleIds?: string[],
  filePaths?: string[],
): Board {
  if (!board.iterations[stateId]) return board;
  if (!principleIds || !filePaths) return board;

  const iteration = board.iterations[stateId];
  const newItems: CannotFixItem[] = [];
  for (const principleId of principleIds) {
    for (const filePath of filePaths) {
      newItems.push({ file_path: filePath, principle_id: principleId });
    }
  }
  if (newItems.length === 0) return board;

  const existing = iteration.cannot_fix ?? [];
  const deduped = newItems.filter(
    (item) =>
      !existing.some((e) => e.principle_id === item.principle_id && e.file_path === item.file_path),
  );
  if (deduped.length === 0) return board;

  return {
    ...board,
    iterations: {
      ...board.iterations,
      [stateId]: { ...iteration, cannot_fix: [...existing, ...deduped] },
    },
  };
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
  stateId: string,
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
  stateId: string,
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
  stateId: string,
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
  stateDef: ResolvedFlow["states"][string] | undefined,
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

function appendConcern(
  board: Board,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
): Board {
  if (input.status_keyword.toLowerCase() !== "done_with_concerns" || !input.concern_text)
    return board;
  const agent = stateDef?.agent ?? input.state_id;
  return {
    ...board,
    concerns: [
      ...board.concerns,
      {
        agent,
        message: input.concern_text,
        state_id: input.state_id,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

type FinalizeTransitionOptions = {
  stateId: string;
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
  if (nextState && nextState !== "hitl") result = { ...result, current_state: nextState };
  return { board: result, hitl_reason, hitl_required };
}

type ResolveHitlOptions = {
  stuck: boolean;
  stuckReason: string | undefined;
  nextState: string | null;
  stateId: string;
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
  workspace: string;
  state_id: string;
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
  // Optional progress line to append to progress.md (saves a separate Write call)
  progress_line?: string;
  // Project directory for drift effect persistence
  project_dir?: string;
  // ADR-015: path to the agent transcript JSONL file (best-effort persistence)
  transcript_path?: string;
};

type LogEntry = {
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

type ReportResultResult = {
  transition_condition: string;
  next_state: string | null;
  board: Board;
  stuck: boolean;
  stuck_reason?: string;
  hitl_required: boolean;
  hitl_reason?: string;
  log_entry: LogEntry;
};

export async function reportResult(
  input: ReportResultInput,
): Promise<ToolResult<ReportResultResult>> {
  return reportResultLocked(input);
}

async function validatePreTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
): Promise<ToolResult<void> | null> {
  if (!store.getBoard()) {
    return toolError("WORKSPACE_NOT_FOUND", `No execution found in workspace: ${input.workspace}`);
  }
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

function executeReportTransaction(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
  debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined,
): TransactionResult {
  return store.transaction((): TransactionResult => {
    let board = store.getBoard();
    if (!board) {
      throw new Error(`No execution found in workspace: ${input.workspace}`);
    }

    const { board: b1, condition } = resolveCondition(board, input, stateDef);
    board = b1;

    let nextState = stateDef ? evaluateTransition(stateDef, condition) : null;

    board = appendConcern(board, input, stateDef);
    board = completeState(board, input.state_id, condition, input.artifacts);
    board = enrichBoardMetrics(board, input);
    board = applyDiscoveries(board, input.state_id, input);

    const stuckResult = detectStuck(board, input.state_id, { condition, input, stateDef, store });
    board = stuckResult.board;
    if (stuckResult.stuck) nextState = null;

    if (condition === "cannot_fix") {
      board = accumulateCannotFix(board, input.state_id, input.principle_ids, input.file_paths);
    }

    let hitl_required = false;
    let hitl_reason: string | undefined;

    if (debateResult !== undefined) {
      const dr = applyDebateResult(board, debateResult, input.state_id, input.flow.debate!);
      board = dr.board;
      nextState = dr.nextState;
      hitl_required = dr.hitl_required;
      hitl_reason = dr.hitl_reason;
    }

    const finalResult = finalizeTransition(board, {
      condition,
      hitl_reason,
      hitl_required,
      nextState,
      stateId: input.state_id,
      stateType: stateDef?.type,
      statusKeyword: input.status_keyword,
      stuckResult,
    });
    board = finalResult.board;
    hitl_required = finalResult.hitl_required;
    hitl_reason = finalResult.hitl_reason;

    syncBoardToStore(store, board);

    return {
      board,
      condition,
      hitl_reason,
      hitl_required,
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

  let debateResult: Awaited<ReturnType<typeof inspectDebateProgress>> | undefined;
  if (input.state_id === input.flow.entry && input.flow.debate) {
    debateResult = await inspectDebateProgress(input.workspace, input.flow.debate);
  }

  const txResult = executeReportTransaction(store, input, stateDef, debateResult);

  return postTransactionSideEffects(store, input, stateDef, txResult);
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

async function postTransactionSideEffects(
  store: ReturnType<typeof getExecutionStore>,
  input: ReportResultInput,
  stateDef: ResolvedFlow["states"][string] | undefined,
  txResult: TransactionResult,
): Promise<ToolResult<ReportResultResult>> {
  const { board, condition, nextState, stuck, stuck_reason, hitl_required, hitl_reason } = txResult;

  persistTranscriptPath(store, input);
  persistProgressLine(store, input.progress_line);
  await runDriftEffects(stateDef, input);
  emitStuckEvent(store, { board, input, stateDef, stuck, stuck_reason });
  emitReportEvents(store, { condition, hitl_reason, hitl_required, input, nextState });

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
    event: import("../orchestration/events.js").FlowEventMap["state_completed"],
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
    event: import("../orchestration/events.js").FlowEventMap["transition_evaluated"],
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
