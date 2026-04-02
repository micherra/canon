/**
 * Stage 5 — Template injection.
 *
 * Appends template usage instructions to ctx.basePrompt when the state
 * declares a template. Uses buildTemplateInjection from variables.ts.
 *
 * Returns ctx unchanged when state has no template field.
 * Warns when CANON_PLUGIN_ROOT is empty but template is declared.
 */

import { buildTemplateInjection } from "../../orchestration/variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Stage 5: Inject template usage instructions into basePrompt.
 *
 * When state.template is declared and CANON_PLUGIN_ROOT is available,
 * appends the template injection string to basePrompt.
 * When CANON_PLUGIN_ROOT is empty, adds a warning and skips injection.
 */
export async function injectTemplates(ctx: PromptContext): Promise<PromptContext> {
  const { state, mergedVariables, input } = ctx;

  // No template declared — return ctx unchanged (same reference)
  if (!state.template) {
    return ctx;
  }

  const pluginDir = mergedVariables.CANON_PLUGIN_ROOT ?? "";

  if (!pluginDir) {
    return {
      ...ctx,
      warnings: [
        ...ctx.warnings,
        `State "${input.state_id}" declares template but CANON_PLUGIN_ROOT is empty — skipping template injection`,
      ],
    };
  }

  const injection = buildTemplateInjection(state.template, pluginDir);

  return {
    ...ctx,
    basePrompt: `${ctx.basePrompt}\n\n${injection}`,
  };
}
