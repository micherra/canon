/**
 * Stage 4 — Variable substitution and cache prefix prepend.
 *
 * Calls substituteVariables on rawInstruction using mergedVariables and
 * sets ctx.basePrompt. Also reads the cache prefix from ExecutionStore
 * and prepends it to basePrompt when non-empty.
 *
 * The cache prefix is a stable context block computed at init_workspace time
 * (added by adr006-03). Returns empty string when no prefix has been set.
 */

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { substituteVariables } from "../../orchestration/variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Stage 4: Substitute variables and prepend cache prefix.
 *
 * Uses ctx.mergedVariables (which includes injected context from stages 1-3)
 * for substitution. Unknown ${...} patterns are left unchanged.
 */
export async function substituteVariablesStage(ctx: PromptContext): Promise<PromptContext> {
  const { input, rawInstruction, mergedVariables } = ctx;

  // Substitute all known variables from mergedVariables
  const substituted = substituteVariables(rawInstruction, mergedVariables);

  // Read cache prefix from store
  const store = getExecutionStore(input.workspace);
  const cachePrefix = store.getCachePrefix();

  // Prepend cache prefix when non-empty, with separator
  const basePrompt = cachePrefix ? `${cachePrefix}\n\n---\n\n${substituted}` : substituted;

  return {
    ...ctx,
    basePrompt,
    cachePrefix: cachePrefix || undefined,
  };
}
