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

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { evaluateSkipWhen } from "../../orchestration/skip-when.ts";
import type { PromptContext, PromptStage, SpawnPromptInput, SpawnPromptResult } from "./types.ts";
import { resolveContext } from "./resolve-context.ts";
import { resolveProgress } from "./resolve-progress.ts";
import { resolveMessages } from "./resolve-messages.ts";
import { substituteVariablesStage } from "./substitute-variables.ts";
import { injectTemplates } from "./inject-templates.ts";
import { injectWaveBriefing } from "./inject-wave-briefing.ts";
import { fanout } from "./fanout.ts";
import { injectCoordination } from "./inject-coordination.ts";
import { validatePrompts } from "./validate.ts";

/**
 * The prompt assembly pipeline: 9 stages applied in sequence.
 * Each stage transforms PromptContext. Stages short-circuit by setting
 * ctx.skip_reason — the runner breaks the loop on first skip.
 */
const PIPELINE: PromptStage[] = [
  resolveContext,         // 1: inject_context injections → mergedVariables
  resolveProgress,        // 2: ${progress} variable → mergedVariables
  resolveMessages,        // 3: ${messages} from channel → mergedVariables
  substituteVariablesStage, // 4: substitute vars → basePrompt (+ cache prefix)
  injectTemplates,        // 5: append template instructions → basePrompt
  injectWaveBriefing,     // 6: append wave guidance + briefing → basePrompt
  fanout,                 // 7: expand basePrompt → prompts[]
  injectCoordination,     // 8: role sub + messaging + metrics footer → prompts[]
  validatePrompts,        // 9: scan for unresolved ${...} → warnings
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
export async function assemblePrompt(input: SpawnPromptInput): Promise<SpawnPromptResult> {
  const { state_id, flow } = input;

  // --- Pre-pipeline: state lookup ---

  const state = flow.states[state_id];
  if (!state) {
    return {
      prompts: [],
      state_type: "unknown",
      skip_reason: `State "${state_id}" not found in flow`,
    };
  }

  if (state.type === "terminal") {
    return { prompts: [], state_type: "terminal" };
  }

  // --- Pre-pipeline: board read (with _board optimization) ---
  //
  // Only read the board when a board-dependent feature is active.
  // If _board is pre-provided (e.g., from enterAndPrepareState), use it
  // directly to avoid a redundant store round-trip.
  const needsBoard =
    !!state.skip_when ||
    (state.inject_context != null && Array.isArray(state.inject_context) && state.inject_context.length > 0) ||
    ("large_diff_threshold" in state && state.large_diff_threshold != null);

  const board =
    input._board ??
    (needsBoard ? getExecutionStore(input.workspace).getBoard() ?? undefined : undefined);

  // If the pipeline needs a board but none was found, fail gracefully
  if (needsBoard && !board) {
    return {
      prompts: [],
      state_type: state.type,
      skip_reason: `Workspace board not initialized for state "${state_id}"`,
    };
  }

  // --- Pre-pipeline: skip_when evaluation ---

  if (state.skip_when) {
    const skipResult = await evaluateSkipWhen(state.skip_when, input.workspace, board!);
    if (skipResult.skip) {
      return {
        prompts: [],
        state_type: state.type,
        skip_reason: `Skipping ${state_id}: ${state.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
      };
    }
  }

  // --- Pre-pipeline: rawInstruction lookup ---

  const rawInstruction = flow.spawn_instructions[state_id];
  if (!rawInstruction) {
    return {
      prompts: [],
      state_type: state.type,
      skip_reason: `No spawn instruction for state "${state_id}"`,
    };
  }

  // --- Initial PromptContext construction ---

  let ctx: PromptContext = {
    input,
    state,
    rawInstruction,
    board,
    mergedVariables: { ...input.variables },
    basePrompt: "",
    prompts: [],
    warnings: [],
  };

  // --- Pipeline execution ---

  for (const stage of PIPELINE) {
    ctx = await stage(ctx);
    // Short-circuit on skip_reason (e.g., HITL from resolveContext)
    if (ctx.skip_reason) {
      break;
    }
  }

  // --- Map PromptContext to SpawnPromptResult ---

  if (ctx.skip_reason) {
    return {
      prompts: [],
      state_type: state.type,
      skip_reason: ctx.skip_reason,
      ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    };
  }

  return {
    prompts: ctx.prompts,
    state_type: state.type,
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    ...(ctx.clusters ? { clusters: ctx.clusters } : {}),
    ...(ctx.timeout_ms != null ? { timeout_ms: ctx.timeout_ms } : {}),
    ...(ctx.fanned_out ? { fanned_out: true } : {}),
  };
}
