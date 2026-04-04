/**
 * Tool: resolve_after_consultations
 *
 * Resolves "after" consultation prompts for a state after all waves complete.
 * This is a pure resolution function — no board reading, no state entry,
 * no convergence check. It runs at the post-completion lifecycle breakpoint.
 *
 * Per decision after-tool-shape-01: standalone tool keeps the "after"
 * lifecycle phase cleanly separated from enterAndPrepareState (pre-spawn).
 */

import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { ConsultationPromptEntry } from "./enter-and-prepare-state.ts";

export type { ConsultationPromptEntry };

export type ResolveAfterConsultationsInput = {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
};

export type ResolveAfterConsultationsResult = {
  consultation_prompts: ConsultationPromptEntry[];
  warnings: string[];
};

/**
 * Resolves "after" consultation prompts for the given state.
 *
 * Reads `flow.states[state_id].consultations.after` and resolves each name
 * via `resolveConsultationPrompt`. Names that cannot be resolved produce
 * warnings rather than errors (handle-partial-failure).
 */
export function resolveAfterConsultations(
  input: ResolveAfterConsultationsInput,
): ResolveAfterConsultationsResult {
  const { state_id, flow, variables } = input;

  const consultation_prompts: ConsultationPromptEntry[] = [];
  const warnings: string[] = [];

  const stateDef = flow.states[state_id];
  if (!stateDef) {
    return { consultation_prompts, warnings };
  }

  const names = stateDef.consultations?.after ?? [];

  for (const name of names) {
    const resolved = resolveConsultationPrompt(name, flow, variables);
    if (resolved) {
      consultation_prompts.push({
        agent: resolved.agent,
        name,
        prompt: resolved.prompt,
        role: resolved.role,
        ...(resolved.timeout ? { timeout: resolved.timeout } : {}),
        ...(resolved.section ? { section: resolved.section } : {}),
      });
    } else {
      warnings.push(
        `After consultation "${name}" could not be resolved for state "${state_id}" — skipping.`,
      );
    }
  }

  return { consultation_prompts, warnings };
}
