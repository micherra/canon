/**
 * mutation-selection-principle-id.test.ts — principle_id derivation for mutation
 * targets (Codex P2 #2 / ADR-0032 code-author join).
 *
 * An agent-def target's target_artifact.id is the AGENT NAME ("engineer"), not a
 * principle. selectMutationTargets must surface the VIOLATED principle from the
 * attributed violation instead, so downstream recurrence/learning stays keyed by
 * principle. Every other artifact kind is unchanged (id == principle).
 *
 * Canon principles:
 *   - errors-are-values: a cliff agent-def with no violation → typed null
 *   - simplicity-first: pure derivation, no contract change
 */

import { describe, expect, it } from "vitest";
import type { FailureAttribution } from "../services/attribution-types.ts";
import {
  classifyArtifact,
  isOverlayPrincipleTarget,
  selectMutationTargets,
} from "../services/mutation-selection.ts";

/** Build an agent-def attribution where target_artifact.id is the AGENT NAME. */
function makeAgentDefAttribution(
  overrides: Partial<{
    agentId: string;
    path: string;
    violationPrincipleId: string | null;
    failure_kind: FailureAttribution["failure_kind"];
    join_basis: FailureAttribution["join_basis"];
  }> = {},
): FailureAttribution {
  const {
    agentId = "engineer",
    path = "agents/engineer.md",
    violationPrincipleId = "errors-are-values",
    failure_kind = "review_violation",
    join_basis = "code_author_agent_def",
  } = overrides;

  return {
    failure_kind,
    hypothesis: `Agent-def at ${path} was present in context during a build that produced violations.`,
    target_artifact: {
      id: agentId, // agent NAME, never a principle — this is the bug source
      kind: "agent-def",
      path,
      content_hash: "abc123",
      char_span: null,
      span_available: false,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations:
      violationPrincipleId === null
        ? []
        : [
            {
              principle_id: violationPrincipleId,
              severity: "BLOCKING" as const,
              file_path: "src/file0.ts",
              message: "Violation 0",
            },
          ],
    owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis,
    transcript_evidence: [],
    confidence: "high",
    presence_in_context: true,
  };
}

/** Build a rule-edge attribution where target_artifact.id IS the principle. */
function makeRuleAttribution(
  overrides: Partial<{
    principleId: string;
    failure_kind: FailureAttribution["failure_kind"];
    join_basis: FailureAttribution["join_basis"];
    violationCount: number;
  }> = {},
): FailureAttribution {
  const {
    principleId = "errors-are-values",
    failure_kind = "review_violation",
    join_basis = "principle_id==artifact_id",
    violationCount = 1,
  } = overrides;
  const path = `rules/${principleId}.md`;

  return {
    failure_kind,
    hypothesis: `Artifact at ${path} was present in context during a build that produced violations.`,
    target_artifact: {
      id: principleId,
      kind: "rule",
      path,
      content_hash: "abc123",
      char_span: null,
      span_available: false,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations: Array.from({ length: violationCount }, (_, i) => ({
      principle_id: principleId,
      severity: "BLOCKING" as const,
      file_path: `src/file${i}.ts`,
      message: `Violation ${i}`,
    })),
    owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis,
    transcript_evidence: [],
    confidence: "high",
    presence_in_context: true,
  };
}

describe("selectMutationTargets — principle_id for agent-def targets", () => {
  it("code-author agent-def → principle_id is the VIOLATED principle, not the agent name", () => {
    const attr = makeAgentDefAttribution({
      agentId: "engineer",
      violationPrincipleId: "errors-are-values",
    });
    const result = selectMutationTargets(
      [attr],
      { "agents/engineer.md": "agent body" },
      { "agents/engineer.md": true },
    );

    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.principle_id).toBe("errors-are-values");
    expect(target.principle_id).not.toBe("engineer");
    expect(target.artifact_class).toBe("agent");
    expect(target.target_path).toBe("agents/engineer.md");
  });

  it("cliff_event agent-def (no attributed violation) → principle_id is null", () => {
    const attr = makeAgentDefAttribution({
      failure_kind: "cliff_event",
      join_basis: "cliff_step_id",
      violationPrincipleId: null,
    });
    const result = selectMutationTargets(
      [attr],
      { "agents/engineer.md": "agent body" },
      { "agents/engineer.md": true },
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].principle_id).toBeNull();
  });

  it("rule-edge attribution → principle_id === target_artifact.id (unchanged)", () => {
    const attr = makeRuleAttribution({ principleId: "errors-are-values" });
    const result = selectMutationTargets(
      [attr],
      { "rules/errors-are-values.md": "rule body" },
      { "rules/errors-are-values.md": true },
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].principle_id).toBe("errors-are-values");
  });

  it("cliff_event on a rule artifact → principle_id === target_artifact.id (unchanged)", () => {
    const attr = makeRuleAttribution({
      principleId: "errors-are-values",
      failure_kind: "cliff_event",
      join_basis: "cliff_step_id",
      violationCount: 0,
    });
    const result = selectMutationTargets(
      [attr],
      { "rules/errors-are-values.md": "rule body" },
      { "rules/errors-are-values.md": true },
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].principle_id).toBe("errors-are-values");
  });
});

// ---------------------------------------------------------------------------
// Overlay .canon/principles/** classification + selection + trust stamping (dc-02)
// ---------------------------------------------------------------------------

describe("classifyArtifact — overlay principle paths", () => {
  it(".canon/principles/rules/x.md → 'principle'", () => {
    expect(classifyArtifact(".canon/principles/rules/x.md", "rule")).toBe("principle");
  });

  it(".canon/principles/conventions/y.md → 'principle'", () => {
    expect(classifyArtifact(".canon/principles/conventions/y.md", "rule")).toBe("principle");
  });
});

describe("isOverlayPrincipleTarget", () => {
  it(".canon/principles/rules/x.md → true", () => {
    expect(isOverlayPrincipleTarget(".canon/principles/rules/x.md")).toBe(true);
  });

  it("principles/rules/x.md (built-in, not overlay) → false", () => {
    expect(isOverlayPrincipleTarget("principles/rules/x.md")).toBe(false);
  });

  it(".canon/kg-languages/x.json (overlay, not principles) → false", () => {
    expect(isOverlayPrincipleTarget(".canon/kg-languages/x.json")).toBe(false);
  });

  it("mcp-server/src/features/evolution/services/mutation-selection.ts → false", () => {
    expect(
      isOverlayPrincipleTarget("mcp-server/src/features/evolution/services/mutation-selection.ts"),
    ).toBe(false);
  });
});

/** Build an overlay-principle attribution — medium confidence, the inferred principle join. */
function makeOverlayPrincipleAttribution(path: string): FailureAttribution {
  return {
    failure_kind: "review_violation",
    hypothesis: `Artifact at ${path} was present in context during a build that produced violations.`,
    target_artifact: {
      id: "project-local-principle",
      kind: "rule",
      path,
      content_hash: "abc123",
      char_span: null,
      span_available: false,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations: [
      {
        principle_id: "project-local-principle",
        severity: "BLOCKING" as const,
        file_path: "src/file0.ts",
        message: "Violation 0",
      },
    ],
    owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis: "principle_id==artifact_id",
    transcript_evidence: [],
    confidence: "medium",
    presence_in_context: true,
  };
}

describe("selectMutationTargets — overlay principle target trust stamping", () => {
  it("an overlay principle attribution → target stamped trust_tier:untrusted-project-local, holdout_exempt:true", () => {
    const path = ".canon/principles/rules/project-local.md";
    const attr = makeOverlayPrincipleAttribution(path);
    const result = selectMutationTargets([attr], { [path]: "# body" }, { [path]: true });

    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.artifact_class).toBe("principle");
    expect(target.trust_tier).toBe("untrusted-project-local");
    expect(target.holdout_exempt).toBe(true);
  });

  it("a built-in principle attribution → target stamped trust_tier:trusted, holdout_exempt:false", () => {
    const path = "principles/conventions/x.md";
    const attr = makeRuleAttribution({ principleId: "x" });
    // makeRuleAttribution builds target_artifact.path as rules/{id}.md — override with a
    // principles/ path via a fresh literal to keep this test's intent explicit.
    const principleAttr: FailureAttribution = {
      ...attr,
      target_artifact: { ...attr.target_artifact, path },
    };
    const result = selectMutationTargets([principleAttr], { [path]: "# body" }, { [path]: true });

    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.trust_tier).toBe("trusted");
    expect(target.holdout_exempt).toBe(false);
  });
});
