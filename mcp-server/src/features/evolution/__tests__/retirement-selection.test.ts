/**
 * retirement-selection.test.ts — Unit tests for selectRetirementReinforcementTargets
 * (Gap 3 Layer 3: consume attribute_outcomes scores into retire/reinforce targets).
 *
 * Split out of mutation-selection.test.ts on file-length grounds (noExcessiveLinesPerFile).
 *
 * ADR-0062 Bug-1 extension: never-pruneable allowlist guard + retire-domain
 * class filter, now that the injected resolver spans principles ∪ rules ∪
 * references ∪ primers ∪ templates (CorpusArtifactLookup).
 *
 * Canon principles:
 *   - errors-are-values: unresolvable/ineligible/blocked scores land in typed
 *     skipped[], never thrown
 *   - no-llm-calls-in-mcp-tools: pure deterministic logic, no I/O, no model calls
 */

import { describe, expect, it } from "vitest";
import type {
  CorpusArtifactLookup,
  ResolvedCorpusArtifact,
} from "../services/corpus-artifact-lookup.ts";
import {
  NEVER_PRUNEABLE_PRINCIPLE_IDS,
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

/** A lookup that resolves any id to the given fixed path/class. */
function fixedResolver(
  path: string,
  artifactClass: ResolvedCorpusArtifact["artifact_class"] = "principle",
): CorpusArtifactLookup {
  return () => ({ artifact_class: artifactClass, body: "# X", path });
}

/** A lookup that derives the path from the id, all with a fixed class. */
function byIdResolver(
  artifactClass: ResolvedCorpusArtifact["artifact_class"] = "principle",
): CorpusArtifactLookup {
  return (id: string) => ({
    artifact_class: artifactClass,
    body: "# X",
    path: `principles/rules/${id}.md`,
  });
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
    const resolve = fixedResolver("principles/rules/bad-principle.md");
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
    const resolve = fixedResolver("principles/rules/good-principle.md");
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].proposal_kind).toBe("reinforce");
  });

  it("net_score within the neutral band is not nominated", () => {
    const score = makeScore({ net_score: 1.5 });
    const resolve = fixedResolver("principles/rules/neutral.md");
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("exactly at the threshold boundary nominates (inclusive)", () => {
    const retireAtBoundary = makeScore({ net_score: -3, principle_id: "boundary-retire" });
    const reinforceAtBoundary = makeScore({ net_score: 3, principle_id: "boundary-reinforce" });
    const resolve = byIdResolver();
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
    const resolve = fixedResolver("register-foo.ts", "rule");
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toEqual([{ principle_id: "ts-only", reason: "not_gate_eligible" }]);
  });

  it("a .canon/-pathed principle is not_gate_eligible (ADR-0027 overlay posture pinned)", () => {
    const score = makeScore({ net_score: -5, principle_id: "overlay-principle" });
    const resolve = fixedResolver(".canon/principles/rules/overlay-principle.md", "principle");
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toEqual([
      { principle_id: "overlay-principle", reason: "not_gate_eligible" },
    ]);
  });

  it("confidence derives from corroboration: >=3 high, >=1 medium, 0 low", () => {
    const high = makeScore({ net_score: -4, corroboration: 3, principle_id: "high-corr" });
    const medium = makeScore({ net_score: -4, corroboration: 1, principle_id: "medium-corr" });
    const low = makeScore({ net_score: -4, corroboration: 0, principle_id: "low-corr" });
    const resolve = byIdResolver();
    const result = selectRetirementReinforcementTargets([high, medium, low], resolve);

    const byId = Object.fromEntries(result.targets.map((t) => [t.principle_id, t.confidence]));
    expect(byId["high-corr"]).toBe("high");
    expect(byId["medium-corr"]).toBe("medium");
    expect(byId["low-corr"]).toBe("low");
  });

  it("supports a custom threshold override", () => {
    const score = makeScore({ net_score: -2 });
    const resolve = fixedResolver("principles/rules/some-principle.md");

    expect(selectRetirementReinforcementTargets([score], resolve).targets).toHaveLength(0);
    expect(
      selectRetirementReinforcementTargets([score], resolve, { threshold: 2 }).targets,
    ).toHaveLength(1);
  });

  it("returned targets have attribution: null and failure_kind: null (no single-violation join)", () => {
    const score = makeScore({ net_score: -4 });
    const resolve = fixedResolver("principles/rules/some-principle.md");
    const result = selectRetirementReinforcementTargets([score], resolve);

    expect(result.targets[0].attribution).toBeNull();
    expect(result.targets[0].failure_kind).toBeNull();
    expect(result.targets[0].gate_eligible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ADR-0062 Bug-1: never-pruneable allowlist guard
  // -------------------------------------------------------------------------

  describe("never-pruneable allowlist (retire-only guard, checked before resolution)", () => {
    it("has exactly the 7 documented ids", () => {
      expect([...NEVER_PRUNEABLE_PRINCIPLE_IDS].sort()).toEqual(
        [
          "fail-closed-by-default",
          "hooks-fail-closed",
          "least-privilege-access",
          "secrets-never-in-code",
          "validate-at-trust-boundaries",
          "agent-artifact-write-before-return",
          "agent-template-required",
        ].sort(),
      );
    });

    it("retire of agent-artifact-write-before-return at net -10 is skipped never_pruneable, even when the lookup RESOLVES it", () => {
      const score = makeScore({
        net_score: -10,
        principle_id: "agent-artifact-write-before-return",
      });
      const resolve = fixedResolver("rules/agent-artifact-write-before-return.md", "rule");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(0);
      expect(result.skipped).toEqual([
        { principle_id: "agent-artifact-write-before-return", reason: "never_pruneable" },
      ]);
    });

    it("retire of agent-template-required at net -10 is skipped never_pruneable", () => {
      const score = makeScore({ net_score: -10, principle_id: "agent-template-required" });
      const resolve = fixedResolver("templates/agent-template-required.md", "template");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(0);
      expect(result.skipped).toEqual([
        { principle_id: "agent-template-required", reason: "never_pruneable" },
      ]);
    });

    it("never_pruneable fires even when the id is otherwise unresolvable (guard beats resolution)", () => {
      const score = makeScore({ net_score: -10, principle_id: "fail-closed-by-default" });
      const result = selectRetirementReinforcementTargets([score], () => null);

      expect(result.targets).toHaveLength(0);
      expect(result.skipped).toEqual([
        { principle_id: "fail-closed-by-default", reason: "never_pruneable" },
      ]);
    });

    it("reinforce of an allowlisted id at net +10 is NOT blocked — target emitted", () => {
      const score = makeScore({
        net_score: 10,
        positive_weight: 10,
        negative_weight: 0,
        principle_id: "agent-artifact-write-before-return",
      });
      const resolve = fixedResolver("rules/agent-artifact-write-before-return.md", "rule");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].proposal_kind).toBe("reinforce");
      expect(result.skipped).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0062 Bug-1: retire-domain class filter
  // -------------------------------------------------------------------------

  describe("retire-domain class filter (retire-only, reinforce unaffected)", () => {
    it("retire of a reference-class id is skipped non_retirable_artifact_class", () => {
      const score = makeScore({ net_score: -5, principle_id: "status-protocol" });
      const resolve = fixedResolver("references/status-protocol.md", "reference");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(0);
      expect(result.skipped).toEqual([
        { principle_id: "status-protocol", reason: "non_retirable_artifact_class" },
      ]);
    });

    it("retire of a primer-class id is skipped non_retirable_artifact_class", () => {
      const score = makeScore({ net_score: -5, principle_id: "testing" });
      const resolve = fixedResolver("primers/testing.md", "primer");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.skipped).toEqual([
        { principle_id: "testing", reason: "non_retirable_artifact_class" },
      ]);
    });

    it("retire of a template-class id is skipped non_retirable_artifact_class", () => {
      const score = makeScore({ net_score: -5, principle_id: "summary" });
      const resolve = fixedResolver("templates/summary.md", "template");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.skipped).toEqual([
        { principle_id: "summary", reason: "non_retirable_artifact_class" },
      ]);
    });

    it("reinforce of a reference-class id is emitted (class filter is retire-only)", () => {
      const score = makeScore({
        net_score: 5,
        positive_weight: 5,
        negative_weight: 0,
        principle_id: "status-protocol",
      });
      const resolve = fixedResolver("references/status-protocol.md", "reference");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].proposal_kind).toBe("reinforce");
      expect(result.targets[0].artifact_class).toBe("reference");
    });

    it("retire of a rules-class id emits a target with correct target_path/artifact_class/score_provenance", () => {
      const score = makeScore({ net_score: -5, principle_id: "agent-context-check" });
      const resolve = fixedResolver("rules/agent-context-check.md", "rule");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].proposal_kind).toBe("retire");
      expect(result.targets[0].artifact_class).toBe("rule");
      expect(result.targets[0].target_path).toBe("rules/agent-context-check.md");
      expect(result.targets[0].score_provenance?.net_score).toBe(-5);
    });

    it("retire of a principle-class id still emits (class filter only excludes ref/primer/template)", () => {
      const score = makeScore({ net_score: -5, principle_id: "some-old-principle" });
      const resolve = fixedResolver("principles/conventions/some-old-principle.md", "principle");
      const result = selectRetirementReinforcementTargets([score], resolve);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].artifact_class).toBe("principle");
    });
  });
});
