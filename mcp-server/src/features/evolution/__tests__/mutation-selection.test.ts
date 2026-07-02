/**
 * mutation-selection.test.ts — Unit tests for the deterministic selection core.
 *
 * Tests:
 * 1. isGateEligible matrix — guardrail, eval-surface, traversal, harness, tool-desc, missing
 * 2. Filter: hash_unverified → skipped; confidence non-"high" → skipped
 * 3. Ranking: violation count descending; weightedCounts tie-break
 * 4. Budget cap: 4 eligible, max 3 → 1 budget_exhausted
 * 5. GateIneligible partition with correct reason
 *
 * Canon principles:
 *   - errors-are-values: selectMutationTargets returns typed buckets, never throws
 *   - no-llm-calls-in-mcp-tools: all functions are pure deterministic logic
 */

import { describe, expect, it } from "vitest";
import type { FailureAttribution } from "../services/attribution-types.ts";
import {
  classifyArtifact,
  isGateEligible,
  selectMutationTargets,
} from "../services/mutation-selection.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttribution(
  path: string,
  overrides: Partial<{
    hash_verified: boolean;
    confidence: FailureAttribution["confidence"];
    violationCount: number;
    kind: "rule" | "ref" | "primer" | "template" | "agent-def";
    principle_id: string | null;
    char_span: [number, number] | null;
  }> = {},
): FailureAttribution {
  const {
    hash_verified = true,
    confidence = "high",
    violationCount = 1,
    kind = "rule",
    principle_id = "agent-tdd-required",
    char_span = null,
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
    join_basis: "principle_id==artifact_id",
    transcript_evidence: [],
    confidence,
    presence_in_context: true,
  };
}

// ---------------------------------------------------------------------------
// 1. isGateEligible matrix
// ---------------------------------------------------------------------------

describe("isGateEligible", () => {
  it("rules/x.md + exists → true (guardrail)", () => {
    expect(isGateEligible("rules/x.md", true)).toBe(true);
  });

  it("primers/y.md + exists → true (guardrail)", () => {
    expect(isGateEligible("primers/y.md", true)).toBe(true);
  });

  it("principles/z.md + exists → true (guardrail)", () => {
    expect(isGateEligible("principles/z.md", true)).toBe(true);
  });

  it("agents/foo.md + exists → true (guardrail)", () => {
    expect(isGateEligible("agents/foo.md", true)).toBe(true);
  });

  it("templates/bar.md + exists → true (guardrail)", () => {
    expect(isGateEligible("templates/bar.md", true)).toBe(true);
  });

  it("references/baz.md + exists → true (guardrail)", () => {
    expect(isGateEligible("references/baz.md", true)).toBe(true);
  });

  it("skills/foo/SKILL.md + exists → true (guardrail skill)", () => {
    expect(isGateEligible("skills/foo/SKILL.md", true)).toBe(true);
  });

  it("skills/canon/evals/eval-set.json + exists → true (eval-surface)", () => {
    expect(isGateEligible("skills/canon/evals/eval-set.json", true)).toBe(true);
  });

  it("rules/missing.md + !exists → false (missing file)", () => {
    expect(isGateEligible("rules/missing.md", false)).toBe(false);
  });

  it("mcp-server/src/app/register-evolution.ts → false (tool-description .ts)", () => {
    expect(isGateEligible("mcp-server/src/app/register-evolution.ts", true)).toBe(false);
  });

  it("register-foo.ts + exists → false (tool-description register-* prefix)", () => {
    expect(isGateEligible("register-foo.ts", true)).toBe(false);
  });

  it("skills/canon/evals/run-evals.sh + exists → false (harness entrypoint)", () => {
    expect(isGateEligible("skills/canon/evals/run-evals.sh", true)).toBe(false);
  });

  it("../../etc/passwd → false (path traversal)", () => {
    expect(isGateEligible("../../etc/passwd", true)).toBe(false);
  });

  it("empty string → false (fail-closed)", () => {
    expect(isGateEligible("", true)).toBe(false);
  });

  it("src/features/foo.ts + exists → false (not a plugin root, is .ts)", () => {
    expect(isGateEligible("src/features/foo.ts", true)).toBe(false);
  });

  it("node_modules/foo/bar.md + exists → false (not a plugin artifact root)", () => {
    expect(isGateEligible("node_modules/foo/bar.md", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. classifyArtifact
// ---------------------------------------------------------------------------

describe("classifyArtifact", () => {
  it("skills/canon/evals/ → eval-surface", () => {
    expect(classifyArtifact("skills/canon/evals/eval-set.json", "rule")).toBe("eval-surface");
  });

  it("principles/ → principle", () => {
    expect(classifyArtifact("principles/foo.md", "rule")).toBe("principle");
  });

  it("rules/ → rule", () => {
    expect(classifyArtifact("rules/agent-foo.md", "rule")).toBe("rule");
  });

  it("primers/ → primer", () => {
    expect(classifyArtifact("primers/testing.md", "primer")).toBe("primer");
  });

  it("agents/ → agent", () => {
    expect(classifyArtifact("agents/engineer.md", "ref")).toBe("agent");
  });

  it("templates/ → template", () => {
    expect(classifyArtifact("templates/prd.md", "template")).toBe("template");
  });

  it("skills/foo/SKILL.md → skill", () => {
    expect(classifyArtifact("skills/foo/SKILL.md", "rule")).toBe("skill");
  });

  it("references/foo.md → reference", () => {
    expect(classifyArtifact("references/status-protocol.md", "ref")).toBe("reference");
  });

  it("register-foo.ts → tool-description", () => {
    expect(classifyArtifact("register-foo.ts", "rule")).toBe("tool-description");
  });

  it("foo.ts → tool-description", () => {
    expect(classifyArtifact("foo.ts", "rule")).toBe("tool-description");
  });
});

// ---------------------------------------------------------------------------
// 3. Filter: hash_unverified and confidence_below_high
// ---------------------------------------------------------------------------

describe("selectMutationTargets — filter", () => {
  it("hash_unverified attributions land in skipped with reason hash_unverified", () => {
    const attributions = [makeAttribution("rules/foo.md", { hash_verified: false })];
    const result = selectMutationTargets(
      attributions,
      { "rules/foo.md": "# content" },
      { "rules/foo.md": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("hash_unverified");
    expect(result.skipped[0].target_path).toBe("rules/foo.md");
  });

  it("confidence below high lands in skipped with reason confidence_below_high", () => {
    const attributions = [
      makeAttribution("rules/foo.md", { confidence: "medium" }),
      makeAttribution("rules/bar.md", { confidence: "low" }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "rules/foo.md": "# foo", "rules/bar.md": "# bar" },
      { "rules/foo.md": true, "rules/bar.md": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason === "confidence_below_high")).toBe(true);
  });

  it("hash_unverified takes precedence over confidence_below_high when both fail", () => {
    const attributions = [
      makeAttribution("rules/foo.md", { hash_verified: false, confidence: "low" }),
    ];
    const result = selectMutationTargets(attributions, {}, { "rules/foo.md": true });

    expect(result.skipped).toHaveLength(1);
    // hash check happens first
    expect(result.skipped[0].reason).toBe("hash_unverified");
  });
});

// ---------------------------------------------------------------------------
// 4. Gate-ineligible partition with correct reason
// ---------------------------------------------------------------------------

describe("selectMutationTargets — gate_ineligible partition", () => {
  it(".ts file → gate_ineligible with reason tool_description_not_loadable", () => {
    const attributions = [makeAttribution("register-foo.ts")];
    const result = selectMutationTargets(
      attributions,
      { "register-foo.ts": "export const x = 1;" },
      { "register-foo.ts": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.gate_ineligible).toHaveLength(1);
    expect(result.gate_ineligible[0].reason).toBe("tool_description_not_loadable");
  });

  it("path traversal → gate_ineligible with reason path_traversal", () => {
    const attributions = [makeAttribution("../../etc/passwd")];
    const result = selectMutationTargets(
      attributions,
      { "../../etc/passwd": "root:x:..." },
      { "../../etc/passwd": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.gate_ineligible).toHaveLength(1);
    expect(result.gate_ineligible[0].reason).toBe("path_traversal");
  });

  it("harness entrypoint → gate_ineligible with reason harness_entrypoint", () => {
    const attributions = [makeAttribution("skills/canon/evals/run-evals.sh")];
    const result = selectMutationTargets(
      attributions,
      { "skills/canon/evals/run-evals.sh": "#!/bin/bash" },
      { "skills/canon/evals/run-evals.sh": true },
    );

    expect(result.targets).toHaveLength(0);
    expect(result.gate_ineligible).toHaveLength(1);
    expect(result.gate_ineligible[0].reason).toBe("harness_entrypoint");
  });

  it("missing file → gate_ineligible with reason file_missing", () => {
    const attributions = [makeAttribution("rules/gone.md")];
    const result = selectMutationTargets(attributions, {}, { "rules/gone.md": false });

    expect(result.targets).toHaveLength(0);
    expect(result.gate_ineligible).toHaveLength(1);
    expect(result.gate_ineligible[0].reason).toBe("file_missing");
  });
});

// ---------------------------------------------------------------------------
// 5. Ranking: violation count descending, weightedCounts tie-break
// ---------------------------------------------------------------------------

describe("selectMutationTargets — ranking", () => {
  it("orders by attributed_violations.length descending", () => {
    const attributions = [
      makeAttribution("rules/a.md", { violationCount: 1 }),
      makeAttribution("rules/b.md", { violationCount: 3 }),
      makeAttribution("rules/c.md", { violationCount: 2 }),
    ];
    const bodies = { "rules/a.md": "a", "rules/b.md": "b", "rules/c.md": "c" };
    const existing = { "rules/a.md": true, "rules/b.md": true, "rules/c.md": true };

    const result = selectMutationTargets(attributions, bodies, existing);

    expect(result.targets.map((t) => t.target_path)).toEqual([
      "rules/b.md",
      "rules/c.md",
      "rules/a.md",
    ]);
  });

  it("uses weightedCounts as a tie-break when violation counts are equal", () => {
    const attributions = [
      makeAttribution("rules/a.md", { violationCount: 2, principle_id: "agent-tdd-required" }),
      makeAttribution("rules/b.md", { violationCount: 2, principle_id: "errors-are-values" }),
    ];
    const bodies = { "rules/a.md": "a", "rules/b.md": "b" };
    const existing = { "rules/a.md": true, "rules/b.md": true };
    const weightedCounts = { "agent-tdd-required": 5, "errors-are-values": 10 };

    const result = selectMutationTargets(attributions, bodies, existing, { weightedCounts });

    // errors-are-values has higher weighted count → should come first
    expect(result.targets[0].target_path).toBe("rules/b.md");
    expect(result.targets[1].target_path).toBe("rules/a.md");
  });
});

// ---------------------------------------------------------------------------
// 6. Budget cap
// ---------------------------------------------------------------------------

describe("selectMutationTargets — budget cap", () => {
  it("caps at DEFAULT_MAX_TARGETS_PER_PASS (3) and adds budget_exhausted to skipped", () => {
    const attributions = [
      makeAttribution("rules/a.md", { violationCount: 4 }),
      makeAttribution("rules/b.md", { violationCount: 3 }),
      makeAttribution("rules/c.md", { violationCount: 2 }),
      makeAttribution("rules/d.md", { violationCount: 1 }),
    ];
    const bodies = Object.fromEntries(
      ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"].map((p) => [p, p]),
    );
    const existing = Object.fromEntries(
      ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"].map((p) => [p, true]),
    );

    const result = selectMutationTargets(attributions, bodies, existing);

    expect(result.targets).toHaveLength(3);
    expect(result.skipped.filter((s) => s.reason === "budget_exhausted")).toHaveLength(1);
    expect(result.skipped.find((s) => s.reason === "budget_exhausted")?.target_path).toBe(
      "rules/d.md",
    );
    expect(result.meta.budget).toBe(3);
    expect(result.meta.selected).toBe(3);
  });

  it("respects custom maxTargetsPerPass option", () => {
    const attributions = [
      makeAttribution("rules/a.md", { violationCount: 2 }),
      makeAttribution("rules/b.md", { violationCount: 1 }),
    ];
    const bodies = { "rules/a.md": "a", "rules/b.md": "b" };
    const existing = { "rules/a.md": true, "rules/b.md": true };

    const result = selectMutationTargets(attributions, bodies, existing, { maxTargetsPerPass: 1 });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].target_path).toBe("rules/a.md");
    expect(result.skipped.filter((s) => s.reason === "budget_exhausted")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. MutationTarget shape
// ---------------------------------------------------------------------------

describe("selectMutationTargets — MutationTarget shape", () => {
  it("builds correct MutationTarget with baseline_body from bodies map", () => {
    const attribution = makeAttribution("rules/agent-tdd.md", {
      violationCount: 2,
      char_span: [10, 50],
      principle_id: "agent-tdd-required",
    });
    const result = selectMutationTargets(
      [attribution],
      { "rules/agent-tdd.md": "# Agent TDD\n\nAlways test first." },
      { "rules/agent-tdd.md": true },
    );

    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.target_path).toBe("rules/agent-tdd.md");
    expect(target.baseline_body).toBe("# Agent TDD\n\nAlways test first.");
    expect(target.char_span).toEqual([10, 50]);
    expect(target.gate_eligible).toBe(true);
    expect(target.confidence).toBe("high");
    expect(target.failure_kind).toBe("review_violation");
    expect(target.principle_id).toBe("agent-tdd-required");
    expect(target.attributed_violation_count).toBe(2);
    expect(target.artifact_class).toBe("rule");
  });

  it("uses empty string as baseline_body when path not in bodies map", () => {
    const attribution = makeAttribution("rules/foo.md");
    const result = selectMutationTargets([attribution], {}, { "rules/foo.md": true });

    expect(result.targets[0].baseline_body).toBe("");
  });

  it("agent-def attribution resolves to artifact_class 'agent', gate_eligible, baseline_body populated (dc-05)", () => {
    const attribution = makeAttribution("agents/engineer.md", {
      kind: "agent-def",
      principle_id: "engineer",
    });
    const result = selectMutationTargets(
      [attribution],
      { "agents/engineer.md": "---\nname: engineer\n---\n\n# Role\n\nWrite code.\n" },
      { "agents/engineer.md": true },
    );

    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target.artifact_class).toBe("agent");
    expect(target.gate_eligible).toBe(true);
    expect(target.baseline_body).toBe("---\nname: engineer\n---\n\n# Role\n\nWrite code.\n");
    // dc-06 guard: no frontmatter line ("name: engineer") appears in any emitted mutable span text.
    // The target itself carries no `sections` field (that lives on the provenance artifact, not
    // the MutationTarget) — this assertion documents that the target contract stays hash+span only.
    expect(target).not.toHaveProperty("sections");
    expect(result.gate_ineligible).toHaveLength(0);
  });

  it("a code_author_agent_def attribution (TASK-002 / dc-07) also resolves to artifact_class 'agent', gate_eligible", () => {
    const attribution: FailureAttribution = {
      ambiguous: false,
      attributed_violations: [
        {
          principle_id: "some-principle",
          severity: "BLOCKING",
          file_path: "src/foo.ts",
          message: "Violation of some-principle",
        },
      ],
      confidence: "high",
      failure_kind: "review_violation",
      hypothesis: "'agents/engineer.md' was engineer's persona when a violation was observed",
      join_basis: "code_author_agent_def",
      owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "engineer" }],
      presence_in_context: true,
      target_artifact: {
        char_span: null,
        content_hash: "abc123",
        hash_status: "verified",
        hash_verified: true,
        id: "engineer",
        kind: "agent-def",
        path: "agents/engineer.md",
        span_available: false,
      },
      transcript_evidence: [],
    };

    const result = selectMutationTargets(
      [attribution],
      { "agents/engineer.md": "---\nname: engineer\n---\n\n# Role\n\nWrite code.\n" },
      { "agents/engineer.md": true },
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].artifact_class).toBe("agent");
    expect(result.targets[0].gate_eligible).toBe(true);
  });

  it("meta tracks attributions_seen, selected, budget", () => {
    const attributions = [
      makeAttribution("rules/a.md"),
      makeAttribution("rules/b.md", { confidence: "medium" }),
    ];
    const result = selectMutationTargets(
      attributions,
      { "rules/a.md": "a" },
      { "rules/a.md": true, "rules/b.md": true },
    );

    expect(result.meta.attributions_seen).toBe(2);
    expect(result.meta.selected).toBe(1);
    expect(result.meta.budget).toBe(3); // DEFAULT_MAX_TARGETS_PER_PASS
  });
});

// ---------------------------------------------------------------------------
// 8. Coalesce by path — aggregate same-path attributions before ranking
// ---------------------------------------------------------------------------

describe("selectMutationTargets — coalesce by path", () => {
  it("coalesces duplicate-path attributions: aggregate count, distinct budget, correct ranking", () => {
    // 4 raw attributions: 2 share rules/a.md (violationCounts 2+1=3 aggregate),
    // plus rules/b.md and rules/c.md each with violationCount 1.
    // Without coalescing: budget=3 takes 3 of the 4 raw attributions — one slot
    // can be consumed by the second rules/a.md entry, starving rules/c.md.
    // With coalescing: 3 distinct paths, aggregate count for a.md=3, all fit in budget.
    const attr1 = makeAttribution("rules/a.md", { violationCount: 2, principle_id: "rule-a" });
    const attr2 = makeAttribution("rules/a.md", { violationCount: 1, principle_id: "rule-a" });
    const attr3 = makeAttribution("rules/b.md", { violationCount: 1, principle_id: "rule-b" });
    const attr4 = makeAttribution("rules/c.md", { violationCount: 1, principle_id: "rule-c" });

    const bodies = {
      "rules/a.md": "a body",
      "rules/b.md": "b body",
      "rules/c.md": "c body",
    };
    const existing = {
      "rules/a.md": true,
      "rules/b.md": true,
      "rules/c.md": true,
    };

    const result = selectMutationTargets([attr1, attr2, attr3, attr4], bodies, existing);

    // 3 distinct target paths (not 4 raw attributions)
    expect(result.targets).toHaveLength(3);
    const paths = result.targets.map((t) => t.target_path);
    expect(paths).toContain("rules/a.md");
    expect(paths).toContain("rules/b.md");
    expect(paths).toContain("rules/c.md");

    // The coalesced path carries the aggregate violation count (2+1=3)
    const aTarget = result.targets.find((t) => t.target_path === "rules/a.md");
    expect(aTarget?.attributed_violation_count).toBe(3);

    // rules/a.md ranks first (highest aggregate count = 3 > 1)
    expect(result.targets[0].target_path).toBe("rules/a.md");

    // Budget: all 3 distinct paths fit; no budget_exhausted entries
    expect(result.skipped.filter((s) => s.reason === "budget_exhausted")).toHaveLength(0);

    // meta.attributions_seen counts raw input, not coalesced
    expect(result.meta.attributions_seen).toBe(4);
    expect(result.meta.selected).toBe(3);
  });
});
