/**
 * Stage 1 — Resolve inject_context injections.
 *
 * Reads context from prior state artifacts and merges resolved variables
 * into ctx.mergedVariables. Calls escapeDollarBrace at the read boundary
 * on each injection result value to prevent unintended variable expansion.
 *
 * Returns ctx unchanged when state has no inject_context.
 * Sets ctx.skip_reason when a HITL injection is required.
 */

import { resolveContextInjections } from "../../orchestration/inject-context.ts";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Stage 1: Resolve inject_context injections.
 *
 * Escapes all injection result values at the read boundary via escapeDollarBrace
 * before merging into mergedVariables. This closes the injection gap where
 * injected text containing ${...} could be re-expanded by substituteVariables.
 */
export async function resolveContext(ctx: PromptContext): Promise<PromptContext> {
  const { state, input, board } = ctx;

  // No inject_context — return ctx unchanged (same reference)
  if (!state.inject_context || state.inject_context.length === 0) {
    return ctx;
  }

  const injectionResult = await resolveContextInjections(
    state.inject_context,
    board!,
    input.workspace,
  );

  const newWarnings = [...ctx.warnings, ...injectionResult.warnings];

  // If HITL is needed (from: user), set skip_reason and return
  if (injectionResult.hitl) {
    return {
      ...ctx,
      skip_reason: `HITL required: inject_context from user — "${injectionResult.hitl.prompt}"`,
      warnings: newWarnings,
    };
  }

  // Escape each injection result value at the read boundary before merging.
  // This is the trust-boundary sanitizer: external text enters the pipeline
  // through this point and must be escaped exactly once.
  const escapedVariables: Record<string, string> = {};
  for (const [key, value] of Object.entries(injectionResult.variables)) {
    escapedVariables[key] = escapeDollarBrace(value);
  }

  return {
    ...ctx,
    mergedVariables: { ...ctx.mergedVariables, ...escapedVariables },
    warnings: newWarnings,
  };
}
