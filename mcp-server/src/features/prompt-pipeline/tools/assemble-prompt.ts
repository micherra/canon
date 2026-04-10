/**
 * Pipeline runner — wires all 9 prompt assembly stages.
 *
 * Handles early returns before the pipeline (terminal state, missing state,
 * missing rawInstruction, skip_when), then iterates through all stages in
 * order. Each stage receives a PromptContext and returns a new one.
 *
 * Canon: deep-modules — assemblePrompt is the single deep interface hiding
 * 9-stage complexity. Callers see one function, not nine.
 */

import type { Board, StateId, WorkspacePath } from "@domains/flows/board-state-schemas.ts";
import { evaluateSkipWhen } from "@domains/flows/skip-when.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type {
  PromptContext,
  PromptStage,
  SpawnPromptInput,
  SpawnPromptResult,
} from "../model/types.ts";
import { injectCoordination } from "../services/inject-coordination.ts";
import { injectTemplates } from "../services/inject-templates.ts";
import { injectWaveBriefing } from "../services/inject-wave-briefing.ts";
import { resolveContext } from "../services/resolve-context.ts";
import { resolveMessages } from "../services/resolve-messages.ts";
import { resolveProgress } from "../services/resolve-progress.ts";
import { substituteVariablesStage } from "../services/substitute-variables.ts";
import { fanout } from "./fanout.ts";
import { validatePrompts } from "./validate.ts";

/**
 * The prompt assembly pipeline: 9 stages applied in sequence.
 * Each stage transforms PromptContext. Stages short-circuit by setting
 * ctx.skip_reason — the runner breaks the loop on first skip.
 */
const PIPELINE: PromptStage[] = [
  resolveContext, // 1: inject_context injections → mergedVariables
  resolveProgress, // 2: ${progress} variable → mergedVariables
  resolveMessages, // 3: ${messages} from channel → mergedVariables
  substituteVariablesStage, // 4: substitute vars → basePrompt (+ cache prefix)
  injectTemplates, // 5: append template instructions → basePrompt
  injectWaveBriefing, // 6: append wave guidance + briefing → basePrompt
  fanout, // 7: expand basePrompt → prompts[]
  injectCoordination, // 8: role sub + messaging + metrics footer → prompts[]
  validatePrompts, // 9: scan for unresolved ${...} → warnings
];

/**
 * Assemble a spawn prompt for the given state.
 *
 * Handles terminal states and early-exit conditions before running the
 * pipeline. The _board optimization: if input._board is provided, no
 * additional store.getBoard() call is made.
 *
 * Canon: functions-do-one-thing — assembles a prompt; does not send it,
 * store it, or make decisions about the result.
 */
/** Check if the state requires a board for its features. */
function stateNeedsBoard(state: SpawnPromptInput["flow"]["states"][StateId]): boolean {
  if (!state) return false;
  if (state.skip_when) return true;
  if (
    state.inject_context != null &&
    Array.isArray(state.inject_context) &&
    state.inject_context.length > 0
  )
    return true;
  if ("large_diff_threshold" in state && state.large_diff_threshold != null) return true;
  return false;
}

/** Resolve the board for the pipeline, using the pre-provided _board or reading from store. */
function resolveBoard(input: SpawnPromptInput, needsBoard: boolean): Board | undefined {
  if (input._board) return input._board;
  if (!needsBoard) return undefined;
  return getExecutionStore(input.workspace).getBoard() ?? undefined;
}

/** Check skip_when condition and return a skip result if the state should be skipped. */
async function checkSkipWhen(
  state: SpawnPromptInput["flow"]["states"][StateId],
  state_id: string,
  workspace: WorkspacePath,
  board: NonNullable<PromptContext["board"]>,
): Promise<SpawnPromptResult | null> {
  if (!state.skip_when) return null;
  const skipResult = await evaluateSkipWhen(state.skip_when, workspace, board);
  if (!skipResult.skip) return null;
  return {
    prompts: [],
    skip_reason: `Skipping ${state_id}: ${state.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
    state_type: state.type,
  };
}

/** Build the final result from a completed pipeline context. */
function buildPipelineResult(ctx: PromptContext): SpawnPromptResult {
  if (ctx.skip_reason) {
    return {
      prompts: [],
      skip_reason: ctx.skip_reason,
      state_type: ctx.state.type,
      ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    };
  }
  return {
    prompts: ctx.prompts,
    state_type: ctx.state.type,
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    ...(ctx.clusters ? { clusters: ctx.clusters } : {}),
    ...(ctx.timeout_ms != null ? { timeout_ms: ctx.timeout_ms } : {}),
    ...(ctx.fanned_out ? { fanned_out: true } : {}),
  };
}

/** Validate preconditions for prompt assembly. Returns a skip result or null. */
async function validatePreconditions(input: SpawnPromptInput): Promise<SpawnPromptResult | null> {
  const { state_id, flow } = input;
  const sid = state_id as StateId;
  const state = flow.states[sid];

  if (!state)
    return {
      prompts: [],
      skip_reason: `State "${state_id}" not found in flow`,
      state_type: "unknown",
    };
  if (state.type === "terminal") return { prompts: [], state_type: "terminal" };

  const needsBoard = stateNeedsBoard(state);
  const board = resolveBoard(input, needsBoard);
  if (needsBoard && !board) {
    return {
      prompts: [],
      skip_reason: `Workspace board not initialized for state "${state_id}"`,
      state_type: state.type,
    };
  }

  if (board) {
    const skipResult = await checkSkipWhen(state, state_id, input.workspace, board);
    if (skipResult) return skipResult;
  }

  if (!flow.spawn_instructions[sid]) {
    return {
      prompts: [],
      skip_reason: `No spawn instruction for state "${state_id}"`,
      state_type: state.type,
    };
  }
  return null;
}

export async function assemblePrompt(input: SpawnPromptInput): Promise<SpawnPromptResult> {
  const earlyExit = await validatePreconditions(input);
  if (earlyExit) return earlyExit;

  const { state_id, flow } = input;
  const sid = state_id as StateId;
  const state = flow.states[sid];
  const board = resolveBoard(input, stateNeedsBoard(state));

  let ctx: PromptContext = {
    basePrompt: "",
    board,
    input,
    mergedVariables: { ...input.variables },
    prompts: [],
    rawInstruction: flow.spawn_instructions[sid],
    state,
    warnings: [],
  };

  try {
    for (const stage of PIPELINE) {
      // biome-ignore lint/performance/noAwaitInLoops: pipeline stages are ordered — each stage receives the output of the previous
      ctx = await stage(ctx);
      if (ctx.skip_reason) break;
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Prompt pipeline error in state "${state_id}": ${detail}`);
    return {
      prompts: [],
      skip_reason: `Pipeline error in state "${state_id}": ${detail}`,
      state_type: state.type,
      ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    };
  }

  return buildPipelineResult(ctx);
}
