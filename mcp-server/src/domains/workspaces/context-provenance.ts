/**
 * Context Provenance — types and pure builder helpers.
 *
 * This file is PURE: types + pure functions only. No I/O, no DB, no store import.
 * Import only `node:crypto` and `splitFrontmatter` from `@shared/lib/frontmatter.ts`
 * (also pure — no I/O; ADR-0030).
 *
 * Design: ADR-0018 — spans are computed against the POST-disclosure final preload_prompt;
 * content_hash is computed from PRE-disclosure content (the real artifact wording).
 * These two facts answer different questions and come from different stages intentionally.
 *
 * Agent-def provenance (ADR-0030): the "agent-def" kind hashes the WHOLE agent file
 * (frontmatter included) so drift detection stays honest, while `sections` — the
 * mutable-scope granularity — cover the body ONLY. Frontmatter is excluded from every
 * section span by construction (offsets start at frontmatterEnd or later).
 */

import { createHash } from "node:crypto";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvenanceArtifactKind = "rule" | "ref" | "primer" | "template" | "agent-def";

/** A body-relative (whole-file-offset) markdown ATX-heading section span. */
export type SectionSpan = { heading: string; span: [number, number] };

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
  sections?: SectionSpan[]; // populated only for kind:"agent-def" — body-only mutable spans
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

/** Matches an ATX heading line (1-6 `#` followed by a space/tab), per line. */
const ATX_HEADING_RE = /^#{1,6}[ \t].*$/gm;

/**
 * Split an agent-def file's BODY into markdown ATX-heading sections. Pure, no I/O.
 *
 * - Frontmatter is split off via `splitFrontmatter` (same fence semantics as every other
 *   frontmatter call site); `frontmatterEnd` is the whole-file char offset where the body
 *   begins. Every returned section span starts at or after `frontmatterEnd` by construction.
 * - The body is split on ATX headings (`^#{1,6}\s`); each section spans from its heading
 *   to the next heading (or EOF). Leading pre-heading preamble becomes one section with
 *   `heading: ""`. An empty body yields no sections.
 * - Fail-open: malformed frontmatter YAML never throws — falls back to treating the whole
 *   file as body (matcher-load-bearing fields are still never mutated because the caller
 *   only ever spans the body region it computed here).
 */
export function computeBodySections(fullFile: string): {
  frontmatterEnd: number;
  sections: SectionSpan[];
} {
  let body: string;
  try {
    body = splitFrontmatter(fullFile).body;
  } catch {
    body = fullFile;
  }
  const frontmatterEnd = fullFile.length - body.length;

  const headings: Array<{ index: number; text: string }> = [];
  ATX_HEADING_RE.lastIndex = 0;
  let match: RegExpExecArray | null = ATX_HEADING_RE.exec(body);
  while (match !== null) {
    headings.push({ index: match.index, text: match[0] });
    match = ATX_HEADING_RE.exec(body);
  }

  const sections: SectionSpan[] = [];
  if (headings.length === 0) {
    if (body.length > 0) {
      sections.push({ heading: "", span: [frontmatterEnd, frontmatterEnd + body.length] });
    }
    return { frontmatterEnd, sections };
  }

  if (headings[0].index > 0) {
    sections.push({ heading: "", span: [frontmatterEnd, frontmatterEnd + headings[0].index] });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    sections.push({
      heading: headings[i].text.trim(),
      span: [frontmatterEnd + start, frontmatterEnd + end],
    });
  }

  return { frontmatterEnd, sections };
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
  /** The agent-def body already read at the spawn seam (resolve_agent_skills). Optional. */
  agentDef?: { path: string; fullFile: string };
}): ContextProvenanceRecord {
  const {
    workspace,
    stepId,
    agentName,
    spawnedAt,
    finalPreloadPrompt,
    sidecarPath,
    skills,
    agentDef,
  } = input;

  const assembled_artifacts: AssembledArtifact[] = skills.map((skill) =>
    buildSkillArtifact(skill, finalPreloadPrompt, sidecarPath),
  );

  if (agentDef) {
    assembled_artifacts.push(buildAgentDefArtifact(agentDef));
  }

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

/** Build one AssembledArtifact for a resolved skill (rule/ref/primer/template). */
function buildSkillArtifact(
  skill: {
    kind: ProvenanceArtifactKind;
    id: string;
    path: string;
    originalContent: string;
    inContextText: string;
    blanked: boolean;
    trust_tier?: ArtifactTrustTier;
  },
  finalPreloadPrompt: string,
  sidecarPath: string | undefined,
): AssembledArtifact {
  // content_hash from PRE-disclosure original content — always, even when blanked
  const content_hash = hashContent(skill.originalContent);
  const trust_tier: ArtifactTrustTier = skill.trust_tier ?? "trusted";

  if (skill.blanked) {
    // Blanked by progressive disclosure: span is null; wording lives in the sidecar file
    return {
      char_span: null,
      content_hash,
      id: skill.id,
      kind: skill.kind,
      path: skill.path,
      sidecar_path: sidecarPath,
      source: "sidecar",
      trust_tier,
    };
  }

  // Locate the span in the POST-disclosure final prompt (errors-are-values: no throw)
  const start = finalPreloadPrompt.indexOf(skill.inContextText);
  const char_span: [number, number] | null =
    start === -1 ? null : [start, start + skill.inContextText.length];

  return {
    char_span,
    content_hash,
    id: skill.id,
    kind: skill.kind,
    path: skill.path,
    trust_tier,
  };
}

/**
 * Build the single agent-def AssembledArtifact. Whole-file hash (frontmatter included —
 * Finding 5: keeps readCurrentBody byte-identity untouched); `sections` cover the BODY
 * only (frontmatter excluded by construction).
 */
function buildAgentDefArtifact(agentDef: { path: string; fullFile: string }): AssembledArtifact {
  const { sections } = computeBodySections(agentDef.fullFile);
  return {
    char_span: null, // body not part of preload_prompt — never indexOf against it
    content_hash: hashContent(agentDef.fullFile),
    id: agentIdFromPath(agentDef.path),
    kind: "agent-def",
    path: agentDef.path,
    sections,
    trust_tier: "trusted",
  };
}

/** Derive the agent name (artifact id) from an `agents/<name>.md` path. No I/O. */
function agentIdFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}
