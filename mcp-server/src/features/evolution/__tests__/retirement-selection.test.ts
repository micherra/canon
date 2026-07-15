/**
 * retirement-selection.test.ts — Unit tests for selectRetirementReinforcementTargets
 * (Gap 3 Layer 3: consume attribute_outcomes scores into retire/reinforce targets).
 *
 * Split out of mutation-selection.test.ts on file-length grounds (noExcessiveLinesPerFile).
 *
 * Canon principles:
 *   - errors-are-values: unresolvable/ineligible scores land in typed skipped[], never thrown
 *   - no-llm-calls-in-mcp-tools: pure deterministic logic, no I/O, no model calls
 */

import { describe, expect, it } from "vitest";
import {
  RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD,
  selectRetirementReinforcementTargets,
} from "../services/mutation-selection.ts";
import type { TrustWeightedScore } from "../services/outcome-attribution.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScore(overrides: Partial<TrustWeightedScore> = {}): TrustWeightedScore {
  return {
    contributing_builds: [{ archive_id: "archive-001", sign: -1, weight: 3.5 }],
    corroboration: 1,
    negative_weight: 3.5,
    net_score: -3.5,
    positive_weight: 0,
    principle_id: "some-principle",
    tier_breakdown: { codex: 0, internal: 3.5 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selectRetirementReinforcementTargets", () => {
  it("threshold constant is 3 (mirrors the learner's weighted_instance_count >= 3 convention)", () => {
    expect(RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD).toBe(3);
  });

  it("net_score <= -threshold nominates a retire target", () => {
    const score = makeScore({ net_score: -3.5, principle_id: "bad-principle" });
    const resolve = () => ({ body: "# Bad Principle", path: "principles/rules/bad-principle.md" });
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].proposal_kind).toBe("retire");
    expect(result.targets[0].principle_id).toBe("bad-principle");
    expect(result.targets[0].target_path).toBe("principles/rules/bad-principle.md");
    expect(result.targets[0].score_provenance).toEqual({
      net_score: -3.5,
      contributing_builds: score.contributing_builds,
    });
  });

  it("net_score >= +threshold nominates a reinforce target", () => {
    const score = makeScore({
      net_score: 4,
      positive_weight: 4,
      negative_weight: 0,
      principle_id: "good-principle",
    });
    const resolve = () => ({
      body: "# Good Principle",
      path: "principles/rules/good-principle.md",
    });
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].proposal_kind).toBe("reinforce");
  });

  it("net_score within the neutral band is not nominated", () => {
    const score = makeScore({ net_score: 1.5 });
    const resolve = () => ({ body: "# Neutral", path: "principles/rules/neutral.md" });
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("exactly at the threshold boundary nominates (inclusive)", () => {
    const retireAtBoundary = makeScore({ net_score: -3, principle_id: "boundary-retire" });
    const reinforceAtBoundary = makeScore({ net_score: 3, principle_id: "boundary-reinforce" });
    const resolve = (id: string) => ({ body: "# X", path: `principles/rules/${id}.md` });
    const result = selectRetirementReinforcementTargets(
      [retireAtBoundary, reinforceAtBoundary],
      resolve,
    );

    expect(result.targets.map((t) => t.proposal_kind).sort()).toEqual(["reinforce", "retire"]);
  });

  it("unresolvable principle_id lands in skipped[] with reason artifact_unresolved (errors-are-values)", () => {
    const score = makeScore({ net_score: -5, principle_id: "missing-principle" });
    const result = selectRetirementReinforcementTargets([score], () => null);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toEqual([
      { principle_id: "missing-principle", reason: "artifact_unresolved" },
    ]);
  });

  it("a gate-ineligible resolved path lands in skipped[] with reason not_gate_eligible", () => {
    const score = makeScore({ net_score: -5, principle_id: "ts-only" });
    const resolve = () => ({ body: "export const x = 1;", path: "register-foo.ts" });
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toEqual([{ principle_id: "ts-only", reason: "not_gate_eligible" }]);
  });

  it("confidence derives from corroboration: >=3 high, >=1 medium, 0 low", () => {
    const high = makeScore({ net_score: -4, corroboration: 3, principle_id: "high-corr" });
    const medium = makeScore({ net_score: -4, corroboration: 1, principle_id: "medium-corr" });
    const low = makeScore({ net_score: -4, corroboration: 0, principle_id: "low-corr" });
    const resolve = (id: string) => ({ body: "# X", path: `principles/rules/${id}.md` });
    const result = selectRetirementReinforcementTargets([high, medium, low], resolve);

    const byId = Object.fromEntries(result.targets.map((t) => [t.principle_id, t.confidence]));
    expect(byId["high-corr"]).toBe("high");
    expect(byId["medium-corr"]).toBe("medium");
    expect(byId["low-corr"]).toBe("low");
  });

  it("supports a custom threshold override", () => {
    const score = makeScore({ net_score: -2 });
    const resolve = () => ({ body: "# X", path: "principles/rules/some-principle.md" });

    expect(selectRetirementReinforcementTargets([score], resolve).targets).toHaveLength(0);
    expect(
      selectRetirementReinforcementTargets([score], resolve, { threshold: 2 }).targets,
    ).toHaveLength(1);
  });

  it("returned targets have attribution: null and failure_kind: null (no single-violation join)", () => {
    const score = makeScore({ net_score: -4 });
    const resolve = () => ({ body: "# X", path: "principles/rules/some-principle.md" });
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets[0].attribution).toBeNull();
    expect(result.targets[0].failure_kind).toBeNull();
    expect(result.targets[0].gate_eligible).toBe(true);
  });
});
