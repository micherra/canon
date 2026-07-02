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

import { relative } from "node:path";
import {
  type ArtifactTrustTier,
  buildContextProvenanceRecord,
  type ContextProvenanceRecord,
  type ProvenanceArtifactKind,
} from "@domains/workspaces/context-provenance.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { ResolveAgentSkillsResult, ResolvedSkill } from "./resolve-agent-skills.ts";

/**
 * Relativize an artifact's absolute on-disk path to be project-root-relative
 * (e.g. "agents/engineer.md" instead of "/abs/plugin/dir/agents/engineer.md").
 *
 * Every downstream consumer of `target_artifact.path` (classifyArtifact,
 * isGateEligible/isGuardrailTarget, isAgentDefTarget in evaluate-candidate.ts)
 * keys on a project-root-relative first path segment ("agents/", "rules/", ...).
 * Recording the absolute path made every one of those checks silently fail on
 * real input — they only ever passed against hand-written relative fixtures.
 *
 * `pluginDir` is the same root the caller used to construct the absolute path
 * in the first place (`resolve(pluginDir, "agents", ...)` / `join(pluginDir,
 * KIND_TO_DIR[kind], ...)`), so `relative(pluginDir, absolutePath)` reverses
 * that construction exactly. Fail-open: when `pluginDir` is absent (direct
 * unit-test calls to emitContextProvenance with no real plugin root), the
 * path is left as-is — unchanged from prior behavior.
 */
function toProjectRelativePath(pluginDir: string | undefined, absolutePath: string): string {
  if (!pluginDir) return absolutePath;
  return relative(pluginDir, absolutePath);
}

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
  pluginDir: string | undefined,
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
      path: toProjectRelativePath(pluginDir, preSk.path),
      // Plugin/frontmatter skills are always trusted — explicit tier for audit clarity.
      // Untrusted-overlay entries use a separate code path with trust_tier: "untrusted-project-local".
      trust_tier: "trusted" as ArtifactTrustTier,
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
 * @param input.pluginDir         - Root the agent-def/skill absolute paths were resolved
 *   against; used to relativize `target_artifact.path` for every artifact kind so
 *   downstream consumers (classifyArtifact, isGateEligible, isAgentDefTarget) key
 *   correctly on the real emitted path. Optional — fail-open when absent (paths recorded
 *   as-is, matching prior behavior).
 */
export function emitContextProvenance(input: {
  workspace?: string;
  stepId?: string;
  disclosed: ResolveAgentSkillsResult;
  preDisclosureSkills: ResolvedSkill[];
  /** The agent-def body already read at the spawn seam. Optional (TASK-001). */
  agentDef?: { path: string; fullFile: string };
  pluginDir?: string;
}): void {
  // Fail-open: no workspace → no store to write to; silent skip.
  if (!input.workspace) return;

  const { workspace, stepId, disclosed, preDisclosureSkills, agentDef, pluginDir } = input;
  const relativizedAgentDef = agentDef
    ? { fullFile: agentDef.fullFile, path: toProjectRelativePath(pluginDir, agentDef.path) }
    : undefined;

  let record: ContextProvenanceRecord;
  try {
    record = buildContextProvenanceRecord({
      agentDef: relativizedAgentDef,
      agentName: disclosed.agent_name,
      finalPreloadPrompt: disclosed.preload_prompt,
      sidecarPath: disclosed.full_data_path,
      skills: buildSkillInputs(preDisclosureSkills, disclosed, pluginDir),
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
