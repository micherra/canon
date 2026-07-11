/**
 * positive-attribution.test.ts — Pure unit tests for the positive (honored) attribution join.
 *
 * No I/O: readCurrentBody is an injected seam.
 * Tests verify:
 * (a) `**id**:` prefix parses to a bare id and joins to an in-context artifact
 * (b) unparseable honored line -> unattributed, reason "unparseable_honored"
 * (c) honored id with no matching provenance artifact -> "no_in_context_artifact"
 * (d) hash mismatch -> flagged, NOT attributed (asymmetric with the negative path by design)
 * (e) empty inputs -> empty buckets, no throw
 *
 * Byte-identity proof: fixture content_hash built via real hashContent(rawBody), mirroring
 * attribution-join.test.ts, proving the UNMODIFIED artifact body re-hashes to hash_verified:true.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed
 *   - errors-are-values: lossy paths are typed buckets, never thrown
 */

import { describe, expect, it } from "vitest";
import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import type { HonoredEntry } from "../services/positive-attribution.ts";
import { attributeHonored } from "../services/positive-attribution.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_RULE_BODY = "# Errors Are Values\n\nNever throw for expected conditions.";
const RULE_HASH = hashContent(RAW_RULE_BODY); // byte-identity proof: real hashContent call

function makeArtifact(
  id: string,
  overrides?: Partial<{
    kind: "rule" | "ref" | "primer" | "template" | "agent-def";
    path: string;
    content_hash: string;
    char_span: [number, number] | null;
  }>,
) {
  return {
    char_span: overrides?.char_span ?? ([0, RAW_RULE_BODY.length] as [number, number]),
    content_hash: overrides?.content_hash ?? RULE_HASH,
    id,
    kind: "rule" as const,
    path: `rules/${id}.md`,
    trust_tier: "trusted" as const,
    ...overrides,
  };
}

function makeProvenance(stepId: string | null, artifactIds: string[]): ContextProvenanceSummary {
  return {
    agent_id: "agent-abc",
    agent_name: "canon:reviewer",
    artifact_count: artifactIds.length,
    artifacts: artifactIds.map((id) => makeArtifact(id)),
    spawned_at: "2026-07-01T00:00:00.000Z",
    step_id: stepId,
  };
}

function makeHonored(raw: string, stepId: string | null = "review"): HonoredEntry {
  return { raw, step_id: stepId };
}

const readsRuleBody = (path: string): string | null =>
  path === "rules/errors-are-values.md" ? RAW_RULE_BODY : null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attributeHonored", () => {
  it("parses a **id**: prefix and joins to an in-context artifact (happy path)", () => {
    const provenance = [makeProvenance("review", ["errors-are-values"])];
    const honored = [makeHonored("**errors-are-values**: consistently used typed results")];

    const result = attributeHonored({ honored, provenance, readCurrentBody: readsRuleBody });

    expect(result.attributions).toHaveLength(1);
    expect(result.unattributed).toHaveLength(0);
    expect(result.flagged).toHaveLength(0);

    const attribution = result.attributions[0];
    expect(attribution.presence_in_context).toBe(true);
    expect(attribution.target_artifact.id).toBe("errors-are-values");
    expect(attribution.target_artifact.hash_verified).toBe(true);
    expect(attribution.owning_steps).toEqual([
      { agent_id: "agent-abc", agent_name: "canon:reviewer", step_id: "review" },
    ]);
    // Presence vocabulary only — never "caused"/"honored-because".
    expect(attribution.hypothesis).not.toMatch(/caused|honored-because/i);
  });

  it("an unparseable honored line -> unattributed, reason unparseable_honored", () => {
    const provenance = [makeProvenance("review", ["errors-are-values"])];
    const honored = [makeHonored("errors-are-values consistently used (no bold prefix)")];

    const result = attributeHonored({ honored, provenance, readCurrentBody: readsRuleBody });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributed).toEqual([{ honored: honored[0], reason: "unparseable_honored" }]);
  });

  it("a parseable honored id with no matching provenance artifact -> no_in_context_artifact", () => {
    const provenance = [makeProvenance("review", ["some-other-rule"])];
    const honored = [makeHonored("**errors-are-values**: consistently used typed results")];

    const result = attributeHonored({ honored, provenance, readCurrentBody: readsRuleBody });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributed).toEqual([
      { honored: honored[0], reason: "no_in_context_artifact" },
    ]);
  });

  it("hash mismatch -> flagged, NOT attributed", () => {
    const provenance = [
      {
        ...makeProvenance("review", []),
        artifacts: [
          makeArtifact("errors-are-values", { content_hash: "stale-hash-does-not-match" }),
        ],
      },
    ];
    const honored = [makeHonored("**errors-are-values**: consistently used typed results")];

    const result = attributeHonored({ honored, provenance, readCurrentBody: readsRuleBody });

    expect(result.attributions).toHaveLength(0);
    expect(result.flagged).toEqual([
      {
        artifact_id: "errors-are-values",
        path: "rules/errors-are-values.md",
        reason: "hash_mismatch",
      },
    ]);
  });

  it("artifact_missing (readCurrentBody returns null) -> flagged, NOT attributed", () => {
    const provenance = [makeProvenance("review", ["errors-are-values"])];
    const honored = [makeHonored("**errors-are-values**: consistently used typed results")];

    const result = attributeHonored({ honored, provenance, readCurrentBody: () => null });

    expect(result.attributions).toHaveLength(0);
    expect(result.flagged).toEqual([
      {
        artifact_id: "errors-are-values",
        path: "rules/errors-are-values.md",
        reason: "artifact_missing",
      },
    ]);
  });

  it("empty inputs -> empty buckets, no throw", () => {
    expect(() =>
      attributeHonored({ honored: [], provenance: [], readCurrentBody: readsRuleBody }),
    ).not.toThrow();

    const result = attributeHonored({
      honored: [],
      provenance: [],
      readCurrentBody: readsRuleBody,
    });
    expect(result.attributions).toEqual([]);
    expect(result.unattributed).toEqual([]);
    expect(result.flagged).toEqual([]);
    expect(result.meta).toEqual({ hash_checks: 0, honored_seen: 0, provenance_steps: 0 });
  });
});
