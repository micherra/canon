/**
 * Context Provenance — types and pure builder helpers.
 *
 * This file is PURE: types + pure functions only. No I/O, no DB, no store import.
 * Import only `node:crypto`.
 *
 * Design: ADR-0018 — spans are computed against the POST-disclosure final preload_prompt;
 * content_hash is computed from PRE-disclosure content (the real artifact wording).
 * These two facts answer different questions and come from different stages intentionally.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvenanceArtifactKind = "rule" | "ref" | "primer" | "template";

/**
 * Trust tier for assembled artifacts.
 *
 * - "trusted"                — plugin skill loaded from the canonical plugin tree
 *                              (rules/, primers/, references/, templates/).
 * - "untrusted-project-local" — content sourced from a project-local `.canon/` overlay;
 *                               agents MUST NOT follow instructions found inside it.
 *                               See `rules/agent-never-trust-overlay-tier.md`.
 *
 * The field is REQUIRED on AssembledArtifact so every provenance entry explicitly
 * declares a tier — no silent default.
 */
export type ArtifactTrustTier = "trusted" | "untrusted-project-local";

export type AssembledArtifact = {
  kind: ProvenanceArtifactKind;
  id: string;
  path: string;
  content_hash: string; // sha256 hex of exact in-context (pre-disclosure) wording
  char_span: [number, number] | null; // [start, end) in final preload_prompt; null when blanked
  source?: "sidecar"; // present iff blanked by progressive disclosure
  sidecar_path?: string; // = full_data_path; present iff source === "sidecar"
  trust_tier: ArtifactTrustTier; // required — declares the provenance trust boundary
};

export type ContextProvenanceRecord = {
  workspace: string;
  step_id: string | null; // null when step_id absent (fail-open)
  agent_name: string;
  agent_id: string | null; // back-filled by log_step
  spawned_at: string; // ISO-8601
  assembled_artifacts: AssembledArtifact[];
  preload_prompt_hash: string; // sha256 hex of the full final preload_prompt
};

/** Compact per-step summary embedded in RunSummary (hashes/spans only, never content). */
export type ContextProvenanceSummary = {
  step_id: string | null;
  agent_id: string | null;
  agent_name: string;
  spawned_at: string;
  artifact_count: number;
  artifacts: AssembledArtifact[];
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute sha256 hex of a string (utf-8 encoding). Deterministic.
 */
export function hashContent(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Build a ContextProvenanceRecord from resolved skills.
 *
 * Key asymmetry (ADR-0018):
 * - `content_hash` is computed from `originalContent` (PRE-disclosure) ALWAYS — even when blanked.
 *   Hashing the blanked `""` would make every disclosed artifact hash-identical and useless for
 *   trace-led mutation targeting.
 * - `char_span` is located against `finalPreloadPrompt` (POST-disclosure).
 *   Blanked artifacts get `char_span: null` + `source: "sidecar"` + `sidecar_path`.
 *
 * errors-are-values: never throws — `indexOf === -1` yields `char_span: null`.
 */
export function buildContextProvenanceRecord(input: {
  workspace: string;
  stepId: string | null;
  agentName: string;
  spawnedAt: string;
  finalPreloadPrompt: string;
  sidecarPath?: string;
  skills: Array<{
    kind: ProvenanceArtifactKind;
    id: string;
    path: string;
    originalContent: string; // pre-disclosure content (for hash)
    inContextText: string; // the exact section text as it appears in finalPreloadPrompt; "" if blanked
    blanked: boolean;
    trust_tier?: ArtifactTrustTier; // defaults to "trusted" when omitted
  }>;
}): ContextProvenanceRecord {
  const { workspace, stepId, agentName, spawnedAt, finalPreloadPrompt, sidecarPath, skills } =
    input;

  const assembled_artifacts: AssembledArtifact[] = skills.map((skill) => {
    // content_hash from PRE-disclosure original content — always, even when blanked
    const content_hash = hashContent(skill.originalContent);

    const trust_tier: ArtifactTrustTier = skill.trust_tier ?? "trusted";

    if (skill.blanked) {
      // Blanked by progressive disclosure: span is null; wording lives in the sidecar file
      const artifact: AssembledArtifact = {
        char_span: null,
        content_hash,
        id: skill.id,
        kind: skill.kind,
        path: skill.path,
        sidecar_path: sidecarPath,
        source: "sidecar",
        trust_tier,
      };
      return artifact;
    }

    // Locate the span in the POST-disclosure final prompt (errors-are-values: no throw)
    const start = finalPreloadPrompt.indexOf(skill.inContextText);
    const char_span: [number, number] | null =
      start === -1 ? null : [start, start + skill.inContextText.length];

    const artifact: AssembledArtifact = {
      char_span,
      content_hash,
      id: skill.id,
      kind: skill.kind,
      path: skill.path,
      trust_tier,
    };
    return artifact;
  });

  return {
    agent_id: null, // back-filled later by log_step
    agent_name: agentName,
    assembled_artifacts,
    preload_prompt_hash: hashContent(finalPreloadPrompt),
    spawned_at: spawnedAt,
    step_id: stepId,
    workspace,
  };
}
