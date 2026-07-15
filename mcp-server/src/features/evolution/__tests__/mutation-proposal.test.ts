/**
 * mutation-proposal.test.ts — Unit tests for shapeMutationProposal.
 *
 * Tests:
 * 1. Frontmatter: type="evolution-candidate", accepted:true, confidence=0.9 for "high"
 * 2. apply_channel: principle/rule → "writer"; primer/agent/template → "engineer-build-flow"
 * 3. Four markdown sections: ## Observation, ## Proposed Change, ## Evidence, ## Impact
 * 4. Filename slug from target_path
 *
 * Canon principles:
 *   - errors-are-values: function has precondition (accepted===true), precondition documented
 */

import { describe, expect, it } from "vitest";
import type { FailureAttribution } from "../services/attribution-types.ts";
import { shapeMutationProposal } from "../services/mutation-proposal.ts";
import type { MutationTarget } from "../services/mutation-types.ts";
import type { EvaluateCandidateResult } from "../tools/evaluate-candidate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvalResult(accepted: boolean, baseline = 1, candidate = 2): EvaluateCandidateResult {
  return {
    accepted,
    regressed: !accepted && candidate < baseline,
    baseline_score: baseline,
    candidate_score: candidate,
    per_split: {
      train: { baseline_passed: baseline, candidate_passed: candidate, total: 3 },
      val: { baseline_passed: baseline, candidate_passed: candidate, total: 3 },
      holdout: { baseline_passed: baseline, candidate_passed: candidate, total: 3 },
    },
    size_delta: 10,
    judge_votes_holdout: 3,
  };
}

function makeTarget(
  targetPath: string,
  artifactClass: MutationTarget["artifact_class"],
  principleId: string | null = "agent-tdd-required",
): MutationTarget {
  const attribution: FailureAttribution = {
    failure_kind: "review_violation",
    hypothesis: "Artifact was present in context.",
    target_artifact: {
      id: principleId ?? targetPath,
      kind: "rule",
      path: targetPath,
      content_hash: "abc123",
      char_span: [0, 100],
      span_available: true,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations: [
      {
        principle_id: principleId ?? "some-principle",
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
    target_path: targetPath,
    artifact_class: artifactClass,
    baseline_body: "# Original content",
    char_span: [0, 100],
    gate_eligible: true,
    confidence: "high",
    failure_kind: "review_violation",
    principle_id: principleId,
    attributed_violation_count: 1,
    attribution,
  };
}

/** Helper: call shapeMutationProposal with default values (index always 1). */
function shape(
  target: MutationTarget,
  candidateText = "# candidate",
  evalResult = makeEvalResult(true),
  ts = "ts",
) {
  return shapeMutationProposal({ candidateText, evalResult, index: 1, target, ts });
}

// ---------------------------------------------------------------------------
// 1. Frontmatter shape
// ---------------------------------------------------------------------------

describe("shapeMutationProposal — frontmatter", () => {
  it("frontmatter.type === 'evolution-candidate'", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.type).toBe("evolution-candidate");
  });

  it("frontmatter.accepted === true", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.accepted).toBe(true);
  });

  it("frontmatter.confidence = 0.9 for attribution confidence 'high'", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.confidence).toBe(0.9);
  });

  it("frontmatter.target = principle_id when available", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule", "agent-tdd-required");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.target).toBe("agent-tdd-required");
  });

  it("frontmatter.target = target_path when principle_id is null", () => {
    const target = makeTarget("agents/engineer.md", "agent", null);
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.target).toBe("agents/engineer.md");
  });

  it("frontmatter.holdout_baseline/candidate from evalResult", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true, 2, 5),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.holdout_baseline).toBe(2);
    expect(result.frontmatter.holdout_candidate).toBe(5);
  });

  it("frontmatter.failure_kind and principle_id from target", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule", "agent-tdd-required");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.failure_kind).toBe("review_violation");
    expect(result.frontmatter.principle_id).toBe("agent-tdd-required");
  });

  it("frontmatter.hash_verified from attribution", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "20260625T143000",
    });

    expect(result.frontmatter.hash_verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. apply_channel routing
// ---------------------------------------------------------------------------

describe("shapeMutationProposal — apply_channel", () => {
  it("principle → writer", () => {
    const target = makeTarget("principles/foo.md", "principle");
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("writer");
  });

  it("rule → writer", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("writer");
  });

  it("primer → engineer-build-flow", () => {
    const target = makeTarget("primers/testing.md", "primer", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
  });

  it("agent → engineer-build-flow", () => {
    const target = makeTarget("agents/engineer.md", "agent", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
  });

  it("template → engineer-build-flow", () => {
    const target = makeTarget("templates/prd.md", "template", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
  });

  it("skill → engineer-build-flow", () => {
    const target = makeTarget("skills/foo/SKILL.md", "skill", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
  });

  it("eval-surface → engineer-build-flow", () => {
    const target = makeTarget("skills/canon/evals/eval-set.json", "eval-surface", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
  });
});

// ---------------------------------------------------------------------------
// 3. Four markdown sections in the body
// ---------------------------------------------------------------------------

describe("shapeMutationProposal — markdown sections", () => {
  it("markdown includes all four required sections", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target, "# candidate text");

    expect(result.markdown).toContain("## Observation");
    expect(result.markdown).toContain("## Proposed Change");
    expect(result.markdown).toContain("## Evidence");
    expect(result.markdown).toContain("## Impact");
  });

  it("markdown contains the candidate body in a fenced block", () => {
    const candidateBody = "# Rewritten rule\n\nNew content here.";
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target, candidateBody);

    expect(result.markdown).toContain(candidateBody);
  });

  it("markdown includes holdout scores in Evidence section", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target, "# candidate", makeEvalResult(true, 3, 7));

    expect(result.markdown).toContain("3");
    expect(result.markdown).toContain("7");
  });

  it("markdown includes YAML frontmatter block", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target);

    expect(result.markdown).toMatch(/^---\n/);
    expect(result.markdown).toContain("type: evolution-candidate");
  });
});

// ---------------------------------------------------------------------------
// 5. proposal_kind default + retire/reinforce shaping (Gap 3 L3)
// ---------------------------------------------------------------------------

describe("shapeMutationProposal — proposal_kind default (backward compat)", () => {
  it("frontmatter.proposal_kind defaults to 'rewrite' when target.proposal_kind is absent", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target);

    expect(result.frontmatter.proposal_kind).toBe("rewrite");
  });

  it("frontmatter.score_provenance is absent for the default rewrite path", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shape(target);

    expect(result.frontmatter.score_provenance).toBeUndefined();
    expect(Object.keys(result.frontmatter)).not.toContain("score_provenance");
  });
});

function makeRetireTarget(): MutationTarget {
  return {
    target_path: "principles/rules/some-principle.md",
    artifact_class: "principle",
    baseline_body: "# Some Principle\n\nOriginal content.",
    char_span: null,
    gate_eligible: true,
    confidence: "high",
    failure_kind: null,
    principle_id: "some-principle",
    attributed_violation_count: 0,
    attribution: null,
    proposal_kind: "retire",
    score_provenance: {
      net_score: -6.5,
      contributing_builds: [
        { archive_id: "archive-001", sign: -1, weight: 2.1 },
        { archive_id: "archive-002", sign: -1, weight: 1.3 },
      ],
    },
  };
}

function makeReinforceTarget(): MutationTarget {
  return {
    ...makeRetireTarget(),
    proposal_kind: "reinforce",
    score_provenance: {
      net_score: 5.2,
      contributing_builds: [{ archive_id: "archive-010", sign: 1, weight: 5.2 }],
    },
  };
}

describe("shapeMutationProposal — retire proposal shape", () => {
  it("apply_channel is always 'writer' for retire, regardless of artifact_class", () => {
    const target = { ...makeRetireTarget(), artifact_class: "agent" as const };
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("writer");
  });

  it("frontmatter.proposal_kind === 'retire'", () => {
    const result = shape(makeRetireTarget());

    expect(result.frontmatter.proposal_kind).toBe("retire");
  });

  it("frontmatter.score_provenance carries the net_score + contributing_builds trace", () => {
    const result = shape(makeRetireTarget());

    expect(result.frontmatter.score_provenance).toEqual({
      net_score: -6.5,
      contributing_builds: [
        { archive_id: "archive-001", sign: -1, weight: 2.1 },
        { archive_id: "archive-002", sign: -1, weight: 1.3 },
      ],
    });
  });

  it("body Impact section states invalidate-don't-delete — mark retired, never delete", () => {
    const result = shape(makeRetireTarget());

    expect(result.markdown).toMatch(/invalidate-don't-delete/i);
    expect(result.markdown).toMatch(/never remove|NEVER remove|never delete/i);
  });

  it("body includes the score provenance trace (net_score + contributing builds)", () => {
    const result = shape(makeRetireTarget());

    expect(result.markdown).toContain("-6.5");
    expect(result.markdown).toContain("archive-001");
    expect(result.markdown).toContain("archive-002");
  });

  it("frontmatter.failure_kind is null (no single violation for a corpus-wide score)", () => {
    const result = shape(makeRetireTarget());

    expect(result.frontmatter.failure_kind).toBeNull();
  });
});

describe("shapeMutationProposal — reinforce proposal shape", () => {
  it("apply_channel is always 'writer' for reinforce", () => {
    const result = shape(makeReinforceTarget());

    expect(result.frontmatter.apply_channel).toBe("writer");
  });

  it("frontmatter.proposal_kind === 'reinforce'", () => {
    const result = shape(makeReinforceTarget());

    expect(result.frontmatter.proposal_kind).toBe("reinforce");
  });

  it("body Impact section is informational — no deletion, no retirement", () => {
    const result = shape(makeReinforceTarget());

    expect(result.markdown).toMatch(/informational/i);
    expect(result.markdown).not.toMatch(/invalidate-don't-delete/i);
  });

  it("frontmatter.score_provenance carries the positive trace", () => {
    const result = shape(makeReinforceTarget());

    expect(result.frontmatter.score_provenance?.net_score).toBe(5.2);
  });
});

describe("shapeMutationProposal — rewrite path unchanged with nullable fields present", () => {
  it("still produces the original apply_channel routing by artifact_class", () => {
    const target = makeTarget("primers/testing.md", "primer", null);
    const result = shape(target);

    expect(result.frontmatter.apply_channel).toBe("engineer-build-flow");
    expect(result.frontmatter.proposal_kind).toBe("rewrite");
  });
});

// ---------------------------------------------------------------------------
// 4. Filename slug
// ---------------------------------------------------------------------------

describe("shapeMutationProposal — filename", () => {
  it("filename starts with zero-padded index", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 1,
      target,
      ts: "ts",
    });

    expect(result.filename).toMatch(/^01-/);
  });

  it("filename for index 3 starts with 03-", () => {
    const target = makeTarget("rules/agent-tdd.md", "rule");
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 3,
      target,
      ts: "ts",
    });

    expect(result.filename).toMatch(/^03-/);
  });

  it("filename contains evolve- and a slug from target_path", () => {
    const target = makeTarget("rules/agent-tdd-required.md", "rule");
    const result = shape(target);

    expect(result.filename).toContain("evolve-");
    expect(result.filename).toMatch(/\.md$/);
  });

  it("filename slug replaces path separators and dots with hyphens", () => {
    const target = makeTarget("agents/engineer.md", "agent", null);
    const result = shapeMutationProposal({
      candidateText: "# candidate",
      evalResult: makeEvalResult(true),
      index: 2,
      target,
      ts: "ts",
    });

    // Should not contain raw "/" or "."
    const slugPart = result.filename.replace(/^02-evolve-/, "").replace(/\.md$/, "");
    expect(slugPart).not.toContain("/");
    expect(slugPart).not.toContain(".");
  });
});
