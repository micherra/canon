/**
 * attribution-join-agent-def.test.ts — agent-def attribution edges (trace-driven-evolution
 * Phase 2): cliff_event → agent-def (TASK-001 / dc-04) and review_violation → agent-def
 * code-author join (TASK-002 / dc-07).
 *
 * Split out of attribution-join.test.ts to stay under the 600-line file cap
 * (noExcessiveLinesPerFile) — same split-by-concern pattern as the
 * resolve-agent-skills*.test.ts / context-provenance*.test.ts families.
 *
 * No I/O: readCurrentBody is an injected seam.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed
 *   - errors-are-values: lossy paths are typed buckets, never thrown
 */

import { describe, expect, it } from "vitest";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import type { ReviewViolation } from "../../../platform/storage/archive/archive-types.ts";
import type { CliffEventRow } from "../../../platform/storage/drift/cliff-events-dao.ts";
import { attributeFailures } from "../services/attribution-join.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_AGENT_DEF_BODY = "---\nname: engineer\n---\n\n# Role\n\nWrite code.\n";
const AGENT_DEF_HASH = hashContent(RAW_AGENT_DEF_BODY);

function makeAgentDefProvenance(stepId: string | null, agentName = "canon:engineer") {
  return {
    step_id: stepId,
    agent_id: "agent-abc",
    agent_name: agentName,
    spawned_at: "2026-06-25T00:00:00.000Z",
    artifact_count: 1,
    artifacts: [
      {
        kind: "agent-def" as const,
        id: "engineer",
        path: "agents/engineer.md",
        content_hash: AGENT_DEF_HASH,
        char_span: null,
        trust_tier: "trusted" as const,
        sections: [{ heading: "# Role", span: [23, 45] as [number, number] }],
      },
    ],
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
    transcript_path: null,
    transcript_uncaptured_reason: null,
    ...overrides,
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

// readCurrentBody that returns a drifted body
const readDrifted = (_path: string): string | null => "# Modified content that differs";

// ---------------------------------------------------------------------------
// Cliff event → agent-def attribution (TASK-001 / dc-04)
// ---------------------------------------------------------------------------

describe("cliff_event → agent-def attribution", () => {
  it("attributes a cliff on the same step_id to the agent-def artifact, hash-verified", () => {
    const provenance = [makeAgentDefProvenance("implement")];
    const cliffEvents: CliffEventRow[] = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents,
      readCurrentBody: (_path) => RAW_AGENT_DEF_BODY,
    });

    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];
    expect(attr.failure_kind).toBe("cliff_event");
    expect(attr.join_basis).toBe("cliff_step_id");
    expect(attr.target_artifact.kind).toBe("agent-def");
    expect(attr.target_artifact.id).toBe("engineer");
    expect(attr.target_artifact.hash_verified).toBe(true);
    expect(attr.confidence).toBe("high");
    expect(attr.presence_in_context).toBe(true);
    expect(result.flagged).toHaveLength(0);
  });

  it("flags a hash-mismatched agent-def artifact (drifted since spawn)", () => {
    const provenance = [makeAgentDefProvenance("implement")];
    const cliffEvents: CliffEventRow[] = [makeCliffEvent("implement")];

    const result = attributeFailures({
      provenance,
      violations: [],
      cliffEvents,
      readCurrentBody: readDrifted,
    });

    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0].target_artifact.hash_verified).toBe(false);
    expect(result.attributions[0].confidence).toBe("low");
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].reason).toBe("hash_mismatch");
  });
});

// ---------------------------------------------------------------------------
// review_violation → agent-def code-author join (TASK-002 / dc-07)
// ---------------------------------------------------------------------------

describe("review_violation → agent-def code-author join", () => {
  it("attributes a review_violation to the code-author (engineer) agent-def, hash-verified, high confidence", () => {
    const provenance = [makeAgentDefProvenance("implement", "engineer")];
    const violations: ReviewViolation[] = [makeViolation("some-other-principle")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: (_path) => RAW_AGENT_DEF_BODY,
    });

    const agentDefAttrs = result.attributions.filter((a) => a.target_artifact.kind === "agent-def");
    expect(agentDefAttrs).toHaveLength(1);
    const attr = agentDefAttrs[0];
    expect(attr.failure_kind).toBe("review_violation");
    expect(attr.join_basis).toBe("code_author_agent_def");
    expect(attr.target_artifact.id).toBe("engineer");
    expect(attr.target_artifact.hash_verified).toBe(true);
    expect(attr.confidence).toBe("high");
    expect(attr.ambiguous).toBe(false);
    expect(attr.presence_in_context).toBe(true);
    expect(attr.attributed_violations).toHaveLength(1);
    // presence vocabulary only — never "caused"/"causes"
    expect(attr.hypothesis.toLowerCase()).not.toContain("caused");
    expect(attr.hypothesis.toLowerCase()).not.toContain("causes");
  });

  it("does NOT drop the existing principle_id==artifact_id rule attribution — both edges coexist", () => {
    const provenance = [makeAgentDefProvenance("implement", "engineer")];
    const violations: ReviewViolation[] = [makeViolation("some-other-principle")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: (_path) => RAW_AGENT_DEF_BODY,
    });

    // No rule artifact ("some-other-principle") is present in provenance in this fixture,
    // so only the agent-def edge fires — this documents that violations WITHOUT a matching
    // rule artifact still get the code-author edge (not silently dropped as unattributed).
    expect(result.unattributed).toHaveLength(0);
    expect(result.attributions).toHaveLength(1);
  });

  it("two engineer steps sharing one agents/engineer.md → ONE agent-def attribution, not ambiguous", () => {
    const provenance = [
      makeAgentDefProvenance("implement-1", "engineer"),
      makeAgentDefProvenance("implement-2", "engineer"),
    ];
    const violations: ReviewViolation[] = [makeViolation("some-principle")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: (_path) => RAW_AGENT_DEF_BODY,
    });

    const agentDefAttrs = result.attributions.filter((a) => a.target_artifact.kind === "agent-def");
    expect(agentDefAttrs).toHaveLength(1);
    expect(agentDefAttrs[0].ambiguous).toBe(false);
    expect(agentDefAttrs[0].owning_steps).toHaveLength(2);
  });

  it("a reviewer-only step's agent-def is NOT attributed (only CODE_AUTHORING_AGENTS)", () => {
    const provenance = [makeAgentDefProvenance("review", "reviewer")];
    const violations: ReviewViolation[] = [makeViolation("some-principle")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: (_path) => RAW_AGENT_DEF_BODY,
    });

    const agentDefAttrs = result.attributions.filter((a) => a.target_artifact.kind === "agent-def");
    expect(agentDefAttrs).toHaveLength(0);
  });

  it("hash-mismatched code-author agent-def → flagged, hash_verified:false, low confidence", () => {
    const provenance = [makeAgentDefProvenance("implement", "engineer")];
    const violations: ReviewViolation[] = [makeViolation("some-principle")];

    const result = attributeFailures({
      provenance,
      violations,
      cliffEvents: [],
      readCurrentBody: readDrifted,
    });

    const agentDefAttrs = result.attributions.filter((a) => a.target_artifact.kind === "agent-def");
    expect(agentDefAttrs).toHaveLength(1);
    expect(agentDefAttrs[0].target_artifact.hash_verified).toBe(false);
    expect(agentDefAttrs[0].confidence).toBe("low");
    expect(result.flagged.some((f) => f.reason === "hash_mismatch")).toBe(true);
  });
});
