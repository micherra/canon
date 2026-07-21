/**
 * mutation-selection-relaxation.test.ts — class-scoped medium-confidence relaxation
 * (dc-01, PROBE-FINDINGS Probe 3). Split out of mutation-selection.test.ts on
 * file-length grounds (noExcessiveLinesPerFile).
 *
 * Probe 3 proved the review_violation→principle join can never exceed "medium"
 * confidence (transcript evidence is unpopulated in v1), so a strict high-only
 * filter structurally excludes the entire principle-wording mutation class. These
 * tests prove the narrow fix: `filterAndPartition` admits a "medium" attribution
 * ONLY when `join_basis === "principle_id==artifact_id"` — every other join_basis
 * stays high-only.
 *
 * Canon principles:
 *   - errors-are-values: selectMutationTargets returns typed buckets, never throws
 *   - no-llm-calls-in-mcp-tools: all functions are pure deterministic logic
 */

import { describe, expect, it } from "vitest";
import type { FailureAttribution } from "../services/attribution-types.ts";
import { selectMutationTargets } from "../services/mutation-selection.ts";

/** Mirrors mutation-selection.test.ts's local makeAttribution helper. */
function makeAttribution(
  path: string,
  overrides: Partial<{
    hash_verified: boolean;
    confidence: FailureAttribution["confidence"];
    violationCount: number;
    kind: "rule" | "ref" | "primer" | "template" | "agent-def";
    principle_id: string | null;
    char_span: [number, number] | null;
    join_basis: FailureAttribution["join_basis"];
  }> = {},
): FailureAttribution {
  const {
    hash_verified = true,
    confidence = "high",
    violationCount = 1,
    kind = "rule",
    principle_id = "agent-tdd-required",
    char_span = null,
    join_basis = "principle_id==artifact_id",
  } = overrides;

  return {
    failure_kind: "review_violation",
    hypothesis: `Artifact at ${path} was present in context during a build that produced violations.`,
    target_artifact: {
      id: principle_id ?? path,
      kind,
      path,
      content_hash: "abc123",
      char_span,
      span_available: char_span !== null,
      hash_verified,
      hash_status: hash_verified ? "verified" : "mismatch",
    },
    attributed_violations: Array.from({ length: violationCount }, (_, i) => ({
      principle_id: principle_id ?? "some-principle",
      severity: "BLOCKING" as const,
      file_path: `src/file${i}.ts`,
      message: `Violation ${i}`,
    })),
    owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis,
    transcript_evidence: [],
    confidence,
    presence_in_context: true,
  };
}

describe("selectMutationTargets — class-scoped confidence relaxation (dc-01)", () => {
  it("medium + join_basis principle_id==artifact_id on a principles/ path → selected, not skipped", () => {
    const attributions = [
      makeAttribution("principles/conventions/x.md", {
        confidence: "medium",
        join_basis: "principle_id==artifact_id",
      }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "principles/conventions/x.md": "# X" },
      { "principles/conventions/x.md": true },
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].target_path).toBe("principles/conventions/x.md");
    expect(result.skipped).toHaveLength(0);
  });

  it("medium confidence on a NON-principle join_basis (code_author_agent_def) still lands in skipped[confidence_below_high]", () => {
    const attributions = [
      makeAttribution("agents/engineer.md", {
        confidence: "medium",
        join_basis: "code_author_agent_def",
        kind: "agent-def",
      }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "agents/engineer.md": "agent body" },
      { "agents/engineer.md": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("confidence_below_high");
  });

  it("medium confidence on cliff_step_id join_basis (non-principle-join class) still lands in skipped[confidence_below_high]", () => {
    const attributions = [
      makeAttribution("principles/conventions/x.md", {
        confidence: "medium",
        join_basis: "cliff_step_id",
      }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "principles/conventions/x.md": "# X" },
      { "principles/conventions/x.md": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("confidence_below_high");
  });

  it("high + join_basis principle_id==artifact_id on a principles/ path → still selected (unchanged)", () => {
    const attributions = [
      makeAttribution("principles/conventions/x.md", {
        confidence: "high",
        join_basis: "principle_id==artifact_id",
      }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "principles/conventions/x.md": "# X" },
      { "principles/conventions/x.md": true },
    );

    expect(result.targets).toHaveLength(1);
  });
});
