/**
 * Stage 3 — Resolve progress variable.
 *
 * Reads the last N progress entries from ExecutionStore and sets
 * ctx.mergedVariables.progress. Calls escapeDollarBrace at the read
 * boundary to prevent unintended variable expansion.
 *
 * Returns ctx unchanged when flow.progress is falsy.
 */

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Stage 3: Resolve the ${progress} variable.
 *
 * Only runs when input.flow.progress is truthy (a non-empty string path).
 * Reads progress entries from ExecutionStore (max 8 entries) and escapes
 * any ${...} patterns at the read boundary.
 */
export async function resolveProgress(ctx: PromptContext): Promise<PromptContext> {
  const { input } = ctx;

  // Only resolve progress if the flow declares a progress path
  if (!input.flow.progress) {
    return ctx;
  }

  const store = getExecutionStore(input.workspace);
  const progressContent = store.getProgress(8);

  return {
    ...ctx,
    mergedVariables: {
      ...ctx.mergedVariables,
      progress: escapeDollarBrace(progressContent),
    },
  };
}
