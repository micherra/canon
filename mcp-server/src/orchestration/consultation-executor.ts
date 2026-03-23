/**
 * Consultation executor — prepares consultation data for the orchestrator.
 *
 * This module is a *preparation* layer, not an agent spawner. The MCP server
 * cannot invoke agents directly; only the orchestrator has the Agent tool.
 * This module:
 *   - Validates that consultations exist in the flow
 *   - Resolves spawn instructions with variable substitution
 *   - Returns structured data the orchestrator uses to spawn agents
 *
 * Timeout enforcement is the orchestrator's responsibility. The
 * ConsultationFragment.timeout field is available for the orchestrator to read
 * but this module does not enforce it.
 */

import type { ConsultationFragment, ConsultationResult, ResolvedFlow } from "./flow-schema.js";
import { substituteVariables } from "./variables.js";

export interface ConsultationInput {
  consultationNames: string[];
  breakpoint: "before" | "between" | "after";
  flow: ResolvedFlow;
  variables: Record<string, string>;
}

export interface ConsultationOutput {
  results: Record<string, ConsultationResult>;
  warnings: string[];
}

/**
 * Prepares consultation data structures for the orchestrator to act on.
 *
 * For each name in consultationNames:
 *   1. Looks up the consultation fragment in flow.consultations — warns and skips if missing.
 *   2. Looks up the spawn instruction in flow.spawn_instructions — warns and skips if missing.
 *   3. Returns a pending ConsultationResult entry the orchestrator can display and track.
 *
 * Missing consultations produce warnings, not exceptions — the function always
 * returns a result (handle-partial-failure).
 */
export async function executeConsultations(
  input: ConsultationInput,
): Promise<ConsultationOutput> {
  const { consultationNames, flow, variables } = input;
  const results: Record<string, ConsultationResult> = {};
  const warnings: string[] = [];

  for (const name of consultationNames) {
    const fragment = flow.consultations?.[name];
    if (!fragment) {
      warnings.push(
        `Consultation "${name}" not found in flow.consultations — skipping.`,
      );
      continue;
    }

    const spawnInstruction = flow.spawn_instructions[name];
    if (!spawnInstruction) {
      warnings.push(
        `Spawn instruction for consultation "${name}" not found in flow.spawn_instructions — skipping.`,
      );
      continue;
    }

    results[name] = { status: "pending" };
  }

  return { results, warnings };
}

/**
 * Resolves a single consultation's spawn prompt with variable substitution.
 *
 * Returns the resolved agent, prompt, and role for the orchestrator to use
 * when spawning the consultation agent. Returns null if the consultation or
 * its spawn instruction cannot be found.
 */
export function resolveConsultationPrompt(
  name: string,
  flow: ResolvedFlow,
  variables: Record<string, string>,
): { agent: string; prompt: string; role: string } | null {
  const fragment = flow.consultations?.[name];
  if (!fragment) {
    return null;
  }

  const spawnInstruction = flow.spawn_instructions[name];
  if (!spawnInstruction) {
    return null;
  }

  return {
    agent: fragment.agent,
    prompt: substituteVariables(spawnInstruction, variables),
    role: fragment.role,
  };
}
