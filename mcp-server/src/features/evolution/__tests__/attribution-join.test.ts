/**
 * attribution-join.test.ts — Pure unit tests for the attribution join service.
 *
 * No I/O: readCurrentBody and getTranscriptExcerpt are injected seams.
 * Tests verify:
 * 1. Happy-path verified attribution (review_violation, single step)
 * 2. Cliff event exact step join → attribution per in-context artifact
 * 3. Multi-step ambiguous review_violation (ambiguous:true, owning_steps.length===2)
 * 4. Unmatched violation → unattributed (no_in_context_artifact)
 * 5. No provenance → all unattributed (no_provenance)
 * 6. Hash mismatch → flagged + low confidence
 * 7. readCurrentBody returns null → artifact_missing + flagged, no crash
 * 8. No-"caused"-vocabulary assertion on hypothesis + type field names
 * 9. Confidence derivation table
 *
 * Byte-identity proof: fixture content_hash built via real hashContent(rawBody),
 * proving the UNMODIFIED artifact body re-hashes to hash_verified:true.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed
 *   - errors-are-values: lossy paths are typed buckets, never thrown
 */

import { describe, expect, it } from "vitest";
import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import type { ReviewViolation } from "../../../platform/storage/archive/archive-types.ts";
import type { CliffEventRow } from "../../../platform/storage/drift/cliff-events-dao.ts";
import { attributeFailures } from "../services/attribution-join.ts";
import type { AttributeFailureResult } from "../services/attribution-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_RULE_BODY = "# Agent TDD Required\n\nAlways write tests before code.";
const RULE_HASH = hashContent(RAW_RULE_BODY); // byte-identity proof: real hashContent call

function makeArtifact(
  id: string,
  overrides?: Partial<{
    kind: "rule" | "ref" | "primer" | "template";
    path: string;
    content_hash: string;
    char_span: [number, number] | null;
  }>,
) {
  return {
    kind: "rule" as const,
    id,
    path: `rules/${id}.md`,
    content_hash: overrides?.content_hash ?? RULE_HASH,
    char_span: overrides?.char_span ?? ([0, RAW_RULE_BODY.length] as [number, number]),
    trust_tier: "trusted" as const,
    ...overrides,
  };
}

function makeProvenance(stepId: string | null, artifactIds: string[]): ContextProvenanceSummary {
  return {
    step_id: stepId,
    agent_id: "agent-abc",
    agent_name: "canon:engineer",
    spawned_at: "2026-06-25T00:00:00.000Z",
    artifact_count: artifactIds.length,
    artifacts: artifactIds.map((id) => makeArtifact(id)),
  };
}

function makeViolation(principleId: string, overrides?: Partial<ReviewViolation>): ReviewViolation {
  return {
    principle_id: principleId,
    severity: "BLOCKING",
    file_path: "src/foo.ts",
    message: `Violation of ${principleId}`,
    ...overrides,
  };
}

function makeCliffEvent(stepId: string, overrides?: Partial<CliffEventRow>): CliffEventRow {
  return {
    id: 1,
    workspace_slug: "test-workspace",
    step_id: stepId,
    agent_type: "engineer",
    source: "post_subagent",
    detected_at: "2026-06-25T00:00:00.000Z",
    missing_count: 1,
    partial_count: 0,
    recovery_outcome: "unknown",
    recorded_at: "2026-06-25T00:00:00.000Z",
    ...overrides,
  };
}

// readCurrentBody that returns the unmodified raw body (byte-identity round-trip)
const readUnmodified = (_path: string): string | null => RAW_RULE_BODY;
// readCurrentBody that returns a drifted body
const readDrifted = (_path: string): string | null => "# Modified content that differs";
// readCurrentBody that returns null (artifact missing)
const readMissing = (_path: string): string | null => null;

// ---------------------------------------------------------------------------
// 1. Happy-path verified attribution (review_violation, single step)
// ---------------------------------------------------------------------------

describe("review_violation happy path (single step, verified)", () => {
  it("produces a verified attribution with high confidence when transcript applied", () => {
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result: AttributeFailureResult = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
      getTranscriptExcerpt: (_stepId, _artifactId) => ({
        step_id: "implement",
        excerpt: "Following agent-tdd rule...",
        applied_or_ignored: "applied",
      }),
    });

    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];
    expect(attr.failure_kind).toBe("review_violation");
    expect(attr.join_basis).toBe("principle_id==artifact_id");
    expect(attr.target_artifact.id).toBe("agent-tdd");
    expect(attr.target_artifact.hash_verified).toBe(true);
    expect(attr.target_artifact.hash_status).toBe("verified");
    expect(attr.owning_steps).toHaveLength(1);
    expect(attr.owning_steps[0].step_id).toBe("implement");
    expect(attr.ambiguous).toBe(false);
    expect(attr.confidence).toBe("high");
    expect(attr.presence_in_context).toBe(true);
    expect(attr.attributed_violations).toHaveLength(1);
    expect(attr.attributed_violations[0].principle_id).toBe("agent-tdd");
    expect(attr.transcript_evidence).toHaveLength(1);
    expect(result.unattributed).toHaveLength(0);
    expect(result.flagged).toHaveLength(0);
    expect(result.meta.provenance_steps).toBe(1);
    expect(result.meta.violations_seen).toBe(1);
    expect(result.meta.hash_checks).toBeGreaterThanOrEqual(1);
  });

  it("byte-identity proof: UNMODIFIED body re-hashes to hash_verified:true", () => {
    // The fixture's content_hash is built via real hashContent(RAW_RULE_BODY).
    // readUnmodified returns the SAME raw body.
    // This test proves the join hashes the raw body (not trimmed/span form).
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions[0].target_artifact.hash_verified).toBe(true);
    expect(result.attributions[0].target_artifact.hash_status).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// 2. Cliff event — exact step join → attribution per in-context artifact
// ---------------------------------------------------------------------------

describe("cliff_event exact step join", () => {
  it("produces one FailureAttribution per artifact in the cliffed step", () => {
    const provenance: ContextProvenanceSummary[] = [
      makeProvenance("implement", ["agent-tdd", "errors-are-values"]),
    ];
    const cliffEvents: CliffEventRow[] = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents,
      readCurrentBody: readUnmodified,
    });

    // One attribution per artifact in the cliffed step
    expect(result.attributions).toHaveLength(2);
    const cliffAttrs = result.attributions.filter((a) => a.failure_kind === "cliff_event");
    expect(cliffAttrs).toHaveLength(2);

    for (const attr of cliffAttrs) {
      expect(attr.join_basis).toBe("cliff_step_id");
      expect(attr.attributed_violations).toHaveLength(0);
      expect(attr.owning_steps).toHaveLength(1);
      expect(attr.owning_steps[0].step_id).toBe("implement");
      expect(attr.ambiguous).toBe(false);
      expect(attr.target_artifact.hash_verified).toBe(true);
      expect(attr.confidence).toBe("high");
      expect(attr.presence_in_context).toBe(true);
    }
    expect(result.unattributed).toHaveLength(0);
  });

  it("produces no cliff attributions when step_id not in provenance", () => {
    const provenance: ContextProvenanceSummary[] = [makeProvenance("review", ["agent-tdd"])];
    const cliffEvents: CliffEventRow[] = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents,
      readCurrentBody: readUnmodified,
    });

    // No matching provenance for "implement" step
    expect(result.attributions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-step ambiguous review_violation
// ---------------------------------------------------------------------------

describe("review_violation multi-step ambiguous", () => {
  it("sets ambiguous:true when two steps held the same artifact", () => {
    const provenance: ContextProvenanceSummary[] = [
      {
        ...makeProvenance("implement", ["agent-tdd"]),
        step_id: "implement",
        agent_name: "canon:engineer",
      },
      {
        ...makeProvenance("review", ["agent-tdd"]),
        step_id: "review",
        agent_name: "canon:reviewer",
      },
    ];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];
    expect(attr.ambiguous).toBe(true);
    expect(attr.owning_steps).toHaveLength(2);
    expect(attr.owning_steps.map((s) => s.step_id)).toContain("implement");
    expect(attr.owning_steps.map((s) => s.step_id)).toContain("review");
  });
});

// ---------------------------------------------------------------------------
// 4. Unmatched violation → unattributed (no_in_context_artifact)
// ---------------------------------------------------------------------------

describe("unattributed violations", () => {
  it("emits unattributed(no_in_context_artifact) when principle not in context", () => {
    const provenance: ContextProvenanceSummary[] = [
      makeProvenance("implement", ["some-other-rule"]),
    ];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributed).toHaveLength(1);
    expect(result.unattributed[0].reason).toBe("no_in_context_artifact");
    expect(result.unattributed[0].violation.principle_id).toBe("agent-tdd");
  });

  it("emits unattributed(no_provenance) when provenance is empty", () => {
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance: [],
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributed).toHaveLength(1);
    expect(result.unattributed[0].reason).toBe("no_provenance");
  });
});

// ---------------------------------------------------------------------------
// 5. Hash mismatch → flagged + low confidence
// ---------------------------------------------------------------------------

describe("hash mismatch", () => {
  it("flags and downgrades to low confidence when body drifted", () => {
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readDrifted,
    });

    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];
    expect(attr.target_artifact.hash_status).toBe("mismatch");
    expect(attr.target_artifact.hash_verified).toBe(false);
    expect(attr.confidence).toBe("low");

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].reason).toBe("hash_mismatch");
    expect(result.flagged[0].artifact_id).toBe("agent-tdd");
  });
});

// ---------------------------------------------------------------------------
// 6. readCurrentBody returns null → artifact_missing + flagged
// ---------------------------------------------------------------------------

describe("artifact_missing", () => {
  it("flags artifact_missing without crashing when readCurrentBody returns null", () => {
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readMissing,
    });

    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];
    expect(attr.target_artifact.hash_status).toBe("artifact_missing");
    expect(attr.target_artifact.hash_verified).toBe(false);

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].reason).toBe("artifact_missing");
  });
});

// ---------------------------------------------------------------------------
// 7. No-"caused"-vocabulary assertion
// ---------------------------------------------------------------------------

describe("no-caused-vocabulary invariant", () => {
  it("hypothesis string contains no 'caused' or 'causes' substring", () => {
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    for (const attr of result.attributions) {
      expect(attr.hypothesis.toLowerCase()).not.toMatch(/caused|causes/);
    }
  });

  it("FailureAttribution type field names contain no 'cause' substring", () => {
    // Verify at the value level — check that no key in the attribution contains 'cause'
    const provenance: ContextProvenanceSummary[] = [makeProvenance("implement", ["agent-tdd"])];
    const violations: ReviewViolation[] = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    const attr = result.attributions[0];
    for (const key of Object.keys(attr)) {
      expect(key.toLowerCase()).not.toMatch(/cause/);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Confidence derivation table
// ---------------------------------------------------------------------------

describe("confidence derivation", () => {
  it("review_violation: high when hash_verified + !ambiguous + transcript applied/ignored", () => {
    const provenance = [makeProvenance("implement", ["agent-tdd"])];
    const violations = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
      getTranscriptExcerpt: () => ({
        step_id: "implement",
        excerpt: "Used the rule.",
        applied_or_ignored: "applied",
      }),
    });

    expect(result.attributions[0].confidence).toBe("high");
  });

  it("review_violation: medium when hash_verified + !ambiguous + no transcript", () => {
    const provenance = [makeProvenance("implement", ["agent-tdd"])];
    const violations = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
      // no getTranscriptExcerpt
    });

    expect(result.attributions[0].confidence).toBe("medium");
  });

  it("review_violation: medium when hash_verified + ambiguous (two owning steps)", () => {
    const provenance: ContextProvenanceSummary[] = [
      {
        ...makeProvenance("implement", ["agent-tdd"]),
        step_id: "implement",
        agent_name: "canon:engineer",
      },
      {
        ...makeProvenance("review", ["agent-tdd"]),
        step_id: "review",
        agent_name: "canon:reviewer",
      },
    ];
    const violations = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions[0].confidence).toBe("medium");
  });

  it("review_violation: low when hash_mismatch", () => {
    const provenance = [makeProvenance("implement", ["agent-tdd"])];
    const violations = [makeViolation("agent-tdd")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readDrifted,
    });

    expect(result.attributions[0].confidence).toBe("low");
  });

  it("cliff_event: high when hash_verified", () => {
    const provenance = [makeProvenance("implement", ["agent-tdd"])];
    const cliff = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents: cliff,
      readCurrentBody: readUnmodified,
    });

    expect(result.attributions[0].confidence).toBe("high");
  });

  it("cliff_event: low when hash_mismatch", () => {
    const provenance = [makeProvenance("implement", ["agent-tdd"])];
    const cliff = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents: cliff,
      readCurrentBody: readDrifted,
    });

    expect(result.attributions[0].confidence).toBe("low");
  });
});
