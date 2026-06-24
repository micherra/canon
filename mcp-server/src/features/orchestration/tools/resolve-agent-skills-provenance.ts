/**
 * Context provenance emit helper for resolve_agent_skills.
 *
 * Extracted into a separate file to keep resolve-agent-skills.ts under the
 * 600-line limit and to make the emit logic independently unit-testable.
 *
 * Design: ADR-0018 — emitted POST-disclosure so char_span reflects the final
 * preload_prompt the agent actually receives. content_hash is computed from
 * PRE-disclosure content (the real artifact wording).
 */

import {
  buildContextProvenanceRecord,
  type ContextProvenanceRecord,
  type ProvenanceArtifactKind,
} from "@domains/workspaces/context-provenance.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { ResolveAgentSkillsResult, ResolvedSkill } from "./resolve-agent-skills.ts";

/** Mapping from skill kind to the label used in the formatted preload section. */
const KIND_LABEL: Record<string, string> = {
  primer: "Domain primer",
  ref: "Reference",
  rule: "Rule",
  template: "Template",
};

/** Build per-skill inputs for buildContextProvenanceRecord. Pure. */
function buildSkillInputs(
  preDisclosureSkills: ResolvedSkill[],
  disclosed: ResolveAgentSkillsResult,
) {
  const hasSidecar = Boolean(disclosed.full_data_path);
  return preDisclosureSkills.map((preSk) => {
    const originalContent = preSk.content;
    const blanked =
      hasSidecar && (disclosed.skills.find((s) => s.id === preSk.id)?.content ?? "") === "";
    const label = KIND_LABEL[preSk.kind] ?? preSk.kind;
    const inContextText = blanked ? "" : `### ${label}: ${preSk.id}\n\n${originalContent.trim()}`;
    return {
      blanked,
      id: preSk.id,
      inContextText,
      kind: preSk.kind as ProvenanceArtifactKind,
      originalContent,
      path: preSk.path,
    };
  });
}

/** Append a pre-built provenance record to the execution store. Fail-open. */
function appendProvenanceEvent(
  workspace: string,
  record: ContextProvenanceRecord,
  stepId?: string,
): void {
  try {
    // Fail-open: store errors must not block spawn. Pattern mirrors logPitfallAuditEvent.
    const store = getExecutionStore(workspace);
    // Pass stepId as correlationId when present; omit 3rd arg when undefined so
    // the store's own getCorrelationId() defaults apply.
    if (stepId !== undefined) {
      store.appendEvent("context_provenance", record as unknown as Record<string, unknown>, stepId);
    } else {
      store.appendEvent("context_provenance", record as unknown as Record<string, unknown>);
    }
  } catch (err) {
    // Fail-open: store errors silently ignored so emit never blocks spawn.
    console.warn(
      "[context-provenance] appendEvent failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Emit a context_provenance event to the execution store.
 *
 * Called AFTER applyAgentSkillsDisclosure returns — so `disclosed.preload_prompt`
 * is the final prompt the agent will see and `char_span` reflects real offsets.
 *
 * Fail-open: errors from the store are caught and warned; they never block spawn.
 * Absent workspace → silent skip (no store available).
 * Absent stepId  → event still written; record.step_id === null (PRD AC #3).
 *
 * @param input.workspace         - Workspace path for execution store lookup.
 * @param input.stepId            - Durable journal step_id join key (optional).
 * @param input.disclosed         - Post-disclosure ResolveAgentSkillsResult.
 * @param input.preDisclosureSkills - Skills array BEFORE disclosure (full content for hash).
 */
export function emitContextProvenance(input: {
  workspace?: string;
  stepId?: string;
  disclosed: ResolveAgentSkillsResult;
  preDisclosureSkills: ResolvedSkill[];
}): void {
  // Fail-open: no workspace → no store to write to; silent skip.
  if (!input.workspace) return;

  const { workspace, stepId, disclosed, preDisclosureSkills } = input;

  let record: ContextProvenanceRecord;
  try {
    record = buildContextProvenanceRecord({
      agentName: disclosed.agent_name,
      finalPreloadPrompt: disclosed.preload_prompt,
      sidecarPath: disclosed.full_data_path,
      skills: buildSkillInputs(preDisclosureSkills, disclosed),
      spawnedAt: new Date().toISOString(),
      stepId: stepId ?? null,
      workspace,
    });
  } catch (err) {
    // Fail-open: builder errors must not block spawn.
    console.warn(
      "[context-provenance] buildContextProvenanceRecord failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  appendProvenanceEvent(workspace, record, stepId);
}
