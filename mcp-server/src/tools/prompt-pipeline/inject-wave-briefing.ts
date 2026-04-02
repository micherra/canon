/**
 * Stage 6: inject-wave-briefing
 *
 * Assembles and appends wave briefing content to the basePrompt.
 *
 * Active when: state type is "wave" or "parallel-per" AND wave != null.
 *
 * This stage is the trust boundary for consultation output summaries and wave
 * guidance content. It calls escapeDollarBrace on each summary before passing
 * to assembleWaveBriefing, ensuring ${...} patterns from agent-produced text
 * cannot be expanded by downstream substituteVariables calls.
 *
 * This stage operates on ctx.basePrompt (pre-fanout). The fanout stage (7)
 * will copy basePrompt into each fanned-out prompt entry, so every agent
 * receives the briefing identically. This is equivalent to the original code
 * that appended briefing per-entry after fanout.
 *
 * Canon: validate-at-trust-boundaries — escaping happens at the read boundary,
 * not at the caller.
 */

import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import type { PromptContext } from "./types.ts";

/**
 * Inject wave guidance and wave briefing into the base prompt.
 * Only active for wave/parallel-per states with a non-null wave number.
 */
export async function injectWaveBriefing(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { wave, workspace, consultation_outputs } = ctx.input;

  // Only active for wave/parallel-per states with a wave number
  if ((state.type !== "wave" && state.type !== "parallel-per") || wave == null) {
    return ctx;
  }

  let basePrompt = ctx.basePrompt;

  // Inject wave guidance — escape at read boundary before appending
  const rawGuidance = await readWaveGuidance(workspace);
  if (rawGuidance) {
    const escapedGuidance = escapeDollarBrace(rawGuidance);
    basePrompt += `\n\n## Wave Guidance (from user)\n\n${escapedGuidance}`;
  }

  // Inject wave briefing from consultation outputs (if provided)
  if (consultation_outputs) {
    // Escape summaries at trust boundary before passing to assembleWaveBriefing
    const escapedOutputs: Record<string, { section?: string; summary: string }> = {};
    for (const [key, output] of Object.entries(consultation_outputs)) {
      escapedOutputs[key] = {
        ...output,
        summary: escapeDollarBrace(output.summary),
      };
    }

    const briefing = assembleWaveBriefing({
      wave,
      summaries: [],
      consultationOutputs: escapedOutputs,
    });

    if (briefing) {
      basePrompt += `\n\n${briefing}`;
    }
  }

  return { ...ctx, basePrompt };
}
