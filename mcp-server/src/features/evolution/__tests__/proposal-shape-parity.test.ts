/**
 * proposal-shape-parity.test.ts — Parity guard between shapeMutationProposal and SKILL.md.
 *
 * The learner is a markdown agent: it hand-rolls the proposal shape described in
 * `skills/canon/skills/evolve-candidate/SKILL.md` Step 4. `shapeMutationProposal`
 * in mutation-proposal.ts is the TS reference spec, fully unit-tested but never
 * called in production. The two must stay in sync — a silent drift would break the
 * contract that `/canon:review-learnings` parses.
 *
 * This test binds them: it extracts the canonical template block (delimited by
 * `<!-- proposal-shape:begin/end -->` markers) from SKILL.md, parses the frontmatter
 * keys and section headers, then asserts SET EQUALITY against what shapeMutationProposal
 * actually produces. Any addition or removal on either side causes a failure.
 *
 * Canon principles:
 *   - agent-integration-boundary-check: parity test prevents silent production drift
 *   - evolution-hard-gate: accepted===true is a precondition, enforced by caller
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FailureAttribution } from "../services/attribution-types.ts";
import { shapeMutationProposal } from "../services/mutation-proposal.ts";
import type { MutationTarget } from "../services/mutation-types.ts";
import type { EvaluateCandidateResult } from "../tools/evaluate-candidate.ts";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// mcp-server/src/features/evolution/__tests__ → 5 levels up → repo root
const REPO_ROOT = resolve(__dirname, "../../../../..");
const SKILL_PATH = resolve(REPO_ROOT, "skills/canon/skills/evolve-candidate/SKILL.md");

// ---------------------------------------------------------------------------
// SKILL.md canonical block extraction
// ---------------------------------------------------------------------------

const BEGIN_MARKER = "<!-- proposal-shape:begin -->";
const END_MARKER = "<!-- proposal-shape:end -->";

function extractCanonicalBlock(skillContent: string): string {
  const begin = skillContent.indexOf(BEGIN_MARKER);
  const end = skillContent.indexOf(END_MARKER);
  if (begin === -1) throw new Error(`'${BEGIN_MARKER}' not found in SKILL.md`);
  if (end === -1) throw new Error(`'${END_MARKER}' not found in SKILL.md`);
  if (end <= begin) throw new Error("end marker appears before begin marker in SKILL.md");
  return skillContent.slice(begin + BEGIN_MARKER.length, end);
}

/** Parse frontmatter key names from the ```yaml fenced block in the canonical block. */
function parseFrontmatterKeys(block: string): Set<string> {
  const match = /```yaml\n([\s\S]*?)```/.exec(block);
  if (!match) throw new Error("```yaml fenced block not found in canonical proposal-shape block");
  const keys = new Set<string>();
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    keys.add(trimmed.slice(0, colonIdx).trim());
  }
  return keys;
}

/** Parse required section headers from the ```text fenced block in the canonical block. */
function parseSectionHeaders(block: string): Set<string> {
  const match = /```text\n([\s\S]*?)```/.exec(block);
  if (!match) throw new Error("```text fenced block not found in canonical proposal-shape block");
  const headers = new Set<string>();
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) headers.add(trimmed);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Synthetic inputs for shapeMutationProposal
// ---------------------------------------------------------------------------

function makeEvalResult(): EvaluateCandidateResult {
  return {
    accepted: true,
    regressed: false,
    baseline_score: 1,
    candidate_score: 2,
    per_split: {
      train: { baseline_passed: 1, candidate_passed: 2, total: 3 },
      val: { baseline_passed: 1, candidate_passed: 2, total: 3 },
      holdout: { baseline_passed: 1, candidate_passed: 2, total: 3 },
    },
    size_delta: 10,
    judge_votes_holdout: 3,
  };
}

function makeTarget(): MutationTarget {
  const attribution: FailureAttribution = {
    failure_kind: "review_violation",
    hypothesis: "Artifact was present in context.",
    target_artifact: {
      id: "agent-tdd-required",
      kind: "rule",
      path: "rules/agent-tdd.md",
      content_hash: "abc123",
      char_span: [0, 100],
      span_available: true,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations: [
      {
        principle_id: "agent-tdd-required",
        severity: "BLOCKING",
        file_path: "src/foo.ts",
        message: "Tests not written first.",
      },
    ],
    owning_steps: [{ step_id: "implement", agent_id: null, agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis: "principle_id==artifact_id",
    transcript_evidence: [],
    confidence: "high",
    presence_in_context: true,
  };

  return {
    target_path: "rules/agent-tdd.md",
    artifact_class: "rule",
    baseline_body: "# Original content",
    char_span: [0, 100],
    gate_eligible: true,
    confidence: "high",
    failure_kind: "review_violation",
    principle_id: "agent-tdd-required",
    attributed_violation_count: 1,
    attribution,
  };
}

/**
 * A retire/reinforce MutationTarget (Gap 3 L3) — carries score_provenance and no
 * attribution, unlike makeTarget()'s violation-based "rewrite" fixture. Used as a
 * second parity fixture so the byte-parity assertion below covers the
 * score_provenance / gated frontmatter keys, not just the rewrite path
 * (Finding 3, Gap 3 review — proposal-shape-parity.test.ts previously only
 * exercised a rewrite fixture, so a retire/reinforce-only key could silently drift).
 */
function makeReinforceTarget(): MutationTarget {
  return {
    target_path: "principles/rules/some-principle.md",
    artifact_class: "rule",
    baseline_body: "# Some Principle",
    char_span: null,
    gate_eligible: true,
    confidence: "high",
    failure_kind: null,
    principle_id: "some-principle",
    attributed_violation_count: 0,
    attribution: null,
    proposal_kind: "reinforce",
    score_provenance: {
      net_score: 6,
      contributing_builds: [{ archive_id: "archive-001", sign: 1, weight: 3.5 }],
    },
  };
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("proposal-shape parity — SKILL.md canonical template vs shapeMutationProposal", () => {
  const skillContent = readFileSync(SKILL_PATH, "utf-8");
  const canonicalBlock = extractCanonicalBlock(skillContent);

  const skillFmKeys = parseFrontmatterKeys(canonicalBlock);
  const skillSections = parseSectionHeaders(canonicalBlock);

  // Fixture 1: the unchanged violation-based "rewrite" path (gated, no score_provenance).
  const rewriteResult = shapeMutationProposal({
    target: makeTarget(),
    candidateText: "# candidate",
    evalResult: makeEvalResult(),
    ts: "20260625T143000",
    index: 1,
  });

  // Fixture 2: the Gap 3 L3 "reinforce" path (ungated — evalResult: null — carries
  // score_provenance). Covers the gated/score_provenance keys the rewrite fixture omits.
  const reinforceResult = shapeMutationProposal({
    target: makeReinforceTarget(),
    candidateText: "# Some Principle",
    evalResult: null,
    ts: "20260625T143000",
    index: 2,
  });

  const actualFmKeys = new Set([
    ...Object.keys(rewriteResult.frontmatter),
    ...Object.keys(reinforceResult.frontmatter),
  ]);
  const actualSections = new Set(
    [rewriteResult, reinforceResult].flatMap((result) =>
      result.markdown
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("## ")),
    ),
  );

  it("SKILL.md canonical block is present and parseable", () => {
    expect(skillFmKeys.size).toBeGreaterThan(0);
    expect(skillSections.size).toBeGreaterThan(0);
  });

  it("frontmatter keys: every shapeMutationProposal key is declared in SKILL.md template", () => {
    for (const key of actualFmKeys) {
      expect(
        skillFmKeys.has(key),
        `shapeMutationProposal key '${key}' missing from SKILL.md template`,
      ).toBe(true);
    }
  });

  it("frontmatter keys: every SKILL.md template key is produced by shapeMutationProposal", () => {
    for (const key of skillFmKeys) {
      expect(
        actualFmKeys.has(key),
        `SKILL.md template key '${key}' not produced by shapeMutationProposal`,
      ).toBe(true);
    }
  });

  it("frontmatter key sets are identical (sorted)", () => {
    expect([...actualFmKeys].sort()).toEqual([...skillFmKeys].sort());
  });

  it("section headers: every shapeMutationProposal section is declared in SKILL.md template", () => {
    for (const hdr of actualSections) {
      expect(
        skillSections.has(hdr),
        `shapeMutationProposal section '${hdr}' missing from SKILL.md template`,
      ).toBe(true);
    }
  });

  it("section headers: every SKILL.md template section is produced by shapeMutationProposal", () => {
    for (const hdr of skillSections) {
      expect(
        actualSections.has(hdr),
        `SKILL.md template section '${hdr}' not produced by shapeMutationProposal`,
      ).toBe(true);
    }
  });

  it("section header sets are identical (sorted)", () => {
    expect([...actualSections].sort()).toEqual([...skillSections].sort());
  });
});
