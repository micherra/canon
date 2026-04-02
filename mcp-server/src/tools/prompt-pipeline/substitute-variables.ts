/**
 * Stage 4 — Variable substitution and cache prefix prepend.
 *
 * Calls substituteVariables on rawInstruction using mergedVariables and
 * sets ctx.basePrompt. Also reads the cache prefix from ExecutionStore
 * and prepends it to basePrompt when non-empty.
 *
 * The cache prefix is a stable context block computed at init_workspace time
 * (added by adr006-03). When getCachePrefix is not yet available on the store
 * (e.g., running against an older store version), degrades gracefully to no prefix.
 */

import { substituteVariables } from "../../orchestration/variables.ts";
import { getExecutionStore } from "../../orchestration/execution-store.ts";
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

  // Read cache prefix from store — degrades gracefully if getCachePrefix not available
  const store = getExecutionStore(input.workspace);
  const getCachePrefix = (store as unknown as { getCachePrefix?: () => string }).getCachePrefix;
  const cachePrefix = typeof getCachePrefix === "function" ? getCachePrefix.call(store) : "";

  // Prepend cache prefix when non-empty
  const basePrompt = cachePrefix ? `${cachePrefix}${substituted}` : substituted;

  return {
    ...ctx,
    basePrompt,
    cachePrefix: cachePrefix || undefined,
  };
}
