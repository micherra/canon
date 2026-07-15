/**
 * outcome-attribution.test.ts — Pure unit tests for the signed, trust-weighted
 * aggregator (aggregateOutcomes).
 *
 * No I/O: readCurrentBody is an injected seam, all RunSummary/CliffEventRow inputs
 * are hand-built fixtures.
 *
 * Covers (per gap3-02-tool-PLAN.md "Tests to write"):
 * - corroboration counting (distinct owning steps summed into TrustWeightedScore.corroboration)
 * - age -> decay wiring (older signal contributes a smaller-magnitude weight)
 * - tier_breakdown sums (defaults to "internal"; "codex" stays 0 — v1 reserved slot)
 * - contributing_builds trace completeness + two-sided net score (dc-03)
 * - determinism (dc-01): identical input -> deep-equal output
 * - agent-def cliff_event with no violation -> unattributed_negative reason "no_principle_id"
 * - flagged pass-through tagged with archive_id
 * - is_adversarial_step heuristic bumps contribution magnitude
 * - meta.decisions_seen threads the (v1-unused) decisions corpus length
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed
 *   - errors-are-values: lossy paths are typed buckets, never thrown
 */

import { describe, expect, it } from "vitest";
import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import type { ReviewResult, RunSummary } from "../../../platform/storage/archive/archive-types.ts";
import type { CliffEventRow } from "../../../platform/storage/drift/cliff-events-dao.ts";
import { aggregateOutcomes } from "../services/outcome-attribution.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RULE_A_ID = "principle-a";
const RULE_A_PATH = `rules/${RULE_A_ID}.md`;
const RULE_A_BODY = "# Principle A\n\nDo the thing.";
const RULE_A_HASH = hashContent(RULE_A_BODY);

const KNOWN_BODIES: Record<string, string> = { [RULE_A_PATH]: RULE_A_BODY };

const readCurrentBody = (path: string): string | null => KNOWN_BODIES[path] ?? null;

function makeArtifact(
  id: string,
  overrides?: Partial<{
    kind: "rule" | "ref" | "primer" | "template" | "agent-def";
    path: string;
    content_hash: string;
  }>,
) {
  return {
    char_span: [0, RULE_A_BODY.length] as [number, number],
    content_hash: overrides?.content_hash ?? RULE_A_HASH,
    id,
    kind: overrides?.kind ?? ("rule" as const),
    path: overrides?.path ?? `rules/${id}.md`,
    trust_tier: "trusted" as const,
  };
}

function makeProvStep(
  stepId: string | null,
  agentName: string,
  artifactIds: string[],
  kind: "rule" | "agent-def" = "rule",
): ContextProvenanceSummary {
  return {
    agent_id: "agent-abc",
    agent_name: agentName,
    artifact_count: artifactIds.length,
    artifacts: artifactIds.map((id) => makeArtifact(id, { kind })),
    spawned_at: "2026-01-01T00:00:00.000Z",
    step_id: stepId,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult>): ReviewResult {
  return {
    files_reviewed: 1,
    honored: [],
    principles_checked: 1,
    verdict: "clean",
    violations: [],
    ...overrides,
  };
}

function makeRunSummary(opts: {
  archiveId: string;
  completedAt: string | null;
  reviewResults: ReviewResult[];
  contextProvenance: ContextProvenanceSummary[];
}): RunSummary {
  return {
    archive_id: opts.archiveId,
    artifact_inventory: { directories: [], files: [], total_files: 0 },
    context_provenance: opts.contextProvenance,
    decision_summaries: [],
    planner_context: null,
    review_results: opts.reviewResults,
    run_metadata: {
      archived_at: opts.completedAt ?? "2026-01-01T00:00:00.000Z",
      branch: "main",
      completed_at: opts.completedAt,
      flow: "test-flow",
      slug: opts.archiveId,
      started_at: null,
      task: "",
      tier: "supervised",
      total_duration_ms: null,
    },
    step_outcomes: [],
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// 1. Corroboration counting
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — corroboration counting", () => {
  it("sums distinct owning steps into TrustWeightedScore.corroboration", () => {
    const provenance = [
      makeProvStep("implement", "canon:engineer", [RULE_A_ID]),
      makeProvStep("fix-1", "canon:engineer", [RULE_A_ID]),
    ];
    const summary = makeRunSummary({
      archiveId: "build-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      contextProvenance: provenance,
      reviewResults: [
        makeReviewResult({
          verdict: "blocking",
          violations: [
            { file_path: null, message: "m", principle_id: RULE_A_ID, severity: "BLOCKING" },
          ],
        }),
      ],
    });

    const result = aggregateOutcomes({
      builds: [{ archive_id: "build-1", cliffEvents: [], summary }],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
    });

    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].principle_id).toBe(RULE_A_ID);
    // 2 distinct owning steps (implement, fix-1) both hold the RULE_A artifact
    expect(result.scores[0].corroboration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Age -> decay wiring
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — age -> decay wiring", () => {
  it("an older signal contributes a smaller-magnitude weight than a newer one", () => {
    const NOW = Date.parse("2026-03-01T00:00:00.000Z");
    const provenance = [makeProvStep("implement", "canon:engineer", [RULE_A_ID])];
    const violation = {
      file_path: null,
      message: "m",
      principle_id: RULE_A_ID,
      severity: "BLOCKING",
    };

    const oldBuild = {
      archive_id: "build-old",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-old",
        completedAt: "2026-01-01T00:00:00.000Z", // 59 days before NOW
        contextProvenance: provenance,
        reviewResults: [makeReviewResult({ verdict: "blocking", violations: [violation] })],
      }),
    };
    const newBuild = {
      archive_id: "build-new",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-new",
        completedAt: "2026-02-28T00:00:00.000Z", // 1 day before NOW
        contextProvenance: provenance,
        reviewResults: [makeReviewResult({ verdict: "blocking", violations: [violation] })],
      }),
    };

    const oldResult = aggregateOutcomes({
      builds: [oldBuild],
      decisions: [],
      now_ms: NOW,
      readCurrentBody,
    });
    const newResult = aggregateOutcomes({
      builds: [newBuild],
      decisions: [],
      now_ms: NOW,
      readCurrentBody,
    });

    const oldWeight = Math.abs(oldResult.scores[0].net_score);
    const newWeight = Math.abs(newResult.scores[0].net_score);
    expect(oldWeight).toBeLessThan(newWeight);
  });
});

// ---------------------------------------------------------------------------
// 3. tier_breakdown sums
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — tier_breakdown", () => {
  it("defaults every contribution to the internal tier; codex stays 0 (v1 reserved slot)", () => {
    const provenance = [makeProvStep("review", "canon:reviewer", [RULE_A_ID])];
    const summary = makeRunSummary({
      archiveId: "build-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      contextProvenance: provenance,
      reviewResults: [makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] })],
    });

    const result = aggregateOutcomes({
      builds: [{ archive_id: "build-1", cliffEvents: [], summary }],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
    });

    const score = result.scores[0];
    expect(score.tier_breakdown.codex).toBe(0);
    expect(score.tier_breakdown.internal).toBeCloseTo(score.net_score, 10);
  });
});

// ---------------------------------------------------------------------------
// 4. Two-sided net score (dc-03) + contributing_builds trace completeness
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — two-sided net score (dc-03)", () => {
  it("a build honoring principle X and another violating X both move the signed score", () => {
    const honoringBuild = {
      archive_id: "build-honor",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-honor",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [makeProvStep("review", "canon:reviewer", [RULE_A_ID])],
        reviewResults: [
          makeReviewResult({
            verdict: "clean",
            honored: [`**${RULE_A_ID}**: consistently applied`],
          }),
        ],
      }),
    };
    const violatingBuild = {
      archive_id: "build-violate",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-violate",
        completedAt: "2026-01-02T00:00:00.000Z",
        contextProvenance: [makeProvStep("implement", "canon:engineer", [RULE_A_ID])],
        reviewResults: [
          makeReviewResult({
            verdict: "blocking",
            violations: [
              { file_path: null, message: "m", principle_id: RULE_A_ID, severity: "BLOCKING" },
            ],
          }),
        ],
      }),
    };

    const result = aggregateOutcomes({
      builds: [honoringBuild, violatingBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-02T00:00:00.000Z"),
      readCurrentBody,
    });

    expect(result.scores).toHaveLength(1);
    const score = result.scores[0];
    expect(score.positive_weight).toBeGreaterThan(0);
    expect(score.negative_weight).toBeGreaterThan(0);
    expect(score.net_score).toBeCloseTo(score.positive_weight - score.negative_weight, 10);

    expect(score.contributing_builds).toHaveLength(2);
    const byArchive = new Map(score.contributing_builds.map((c) => [c.archive_id, c]));
    expect(byArchive.get("build-honor")?.sign).toBe(1);
    expect(byArchive.get("build-violate")?.sign).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 5. Determinism (dc-01)
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — determinism (dc-01)", () => {
  it("identical input produces deep-equal output across two calls", () => {
    const provenance = [
      makeProvStep("implement", "canon:engineer", [RULE_A_ID]),
      makeProvStep("review", "canon:reviewer", [RULE_A_ID]),
    ];
    const summary = makeRunSummary({
      archiveId: "build-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      contextProvenance: provenance,
      reviewResults: [
        makeReviewResult({
          honored: [`**${RULE_A_ID}**: good`],
          verdict: "warning",
          violations: [
            { file_path: null, message: "m", principle_id: RULE_A_ID, severity: "WARNING" },
          ],
        }),
      ],
    });

    const input = {
      builds: [{ archive_id: "build-1", cliffEvents: [], summary }],
      decisions: [],
      now_ms: Date.parse("2026-01-05T00:00:00.000Z"),
      readCurrentBody,
    };

    const first = aggregateOutcomes(input);
    const second = aggregateOutcomes(input);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 6. Agent-def cliff_event with no violation -> "no_principle_id"
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — agent-def cliff with no violation", () => {
  it("emits unattributed_negative reason no_principle_id and scores nothing", () => {
    const provenance = [makeProvStep("implement", "engineer", ["engineer"], "agent-def")];
    const cliffEvents: CliffEventRow[] = [
      {
        agent_type: null,
        detected_at: "2026-01-01T00:00:00.000Z",
        id: 1,
        missing_count: 1,
        partial_count: 0,
        recorded_at: "2026-01-01T00:00:00.000Z",
        recovery_outcome: "unknown",
        source: "resume",
        step_id: "implement",
        transcript_path: null,
        transcript_uncaptured_reason: null,
        workspace_slug: "build-cliff",
      },
    ];
    const summary = makeRunSummary({
      archiveId: "build-cliff",
      completedAt: "2026-01-01T00:00:00.000Z",
      contextProvenance: provenance,
      reviewResults: [],
    });

    const result = aggregateOutcomes({
      builds: [{ archive_id: "build-cliff", cliffEvents, summary }],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody: () => "# Engineer\n\nagent def body.",
    });

    expect(result.scores).toHaveLength(0);
    expect(result.unattributed_negative).toHaveLength(1);
    expect(result.unattributed_negative[0]).toMatchObject({
      archive_id: "build-cliff",
      failure_kind: "cliff_event",
      reason: "no_principle_id",
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Flagged pass-through tagged with archive_id
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — flagged pass-through", () => {
  it("tags a hash-mismatched artifact with the originating archive_id", () => {
    const provenance = [makeProvStep("implement", "canon:engineer", [RULE_A_ID])];
    const summary = makeRunSummary({
      archiveId: "build-drift",
      completedAt: "2026-01-01T00:00:00.000Z",
      contextProvenance: provenance,
      reviewResults: [
        makeReviewResult({
          verdict: "blocking",
          violations: [
            { file_path: null, message: "m", principle_id: RULE_A_ID, severity: "BLOCKING" },
          ],
        }),
      ],
    });

    const result = aggregateOutcomes({
      builds: [{ archive_id: "build-drift", cliffEvents: [], summary }],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      // Wrong content -> hash mismatch -> flagged. The NEGATIVE path (unlike the
      // positive/honored path) still attributes at lower confidence on mismatch
      // (attribution-join.ts's documented asymmetry) — so this still scores, just
      // flagged in parallel as an auditable drift signal.
      readCurrentBody: () => "# Principle A\n\nSOMETHING ELSE.",
    });

    expect(result.scores).toHaveLength(1);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      archive_id: "build-drift",
      artifact_id: RULE_A_ID,
      reason: "hash_mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// 8. is_adversarial_step heuristic
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — is_adversarial_step heuristic", () => {
  it("a step_id containing 'adversarial' contributes a larger-magnitude weight", () => {
    const violation = {
      file_path: null,
      message: "m",
      principle_id: RULE_A_ID,
      severity: "BLOCKING",
    };
    const plainBuild = {
      archive_id: "build-plain",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-plain",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [makeProvStep("review", "canon:reviewer", [RULE_A_ID])],
        reviewResults: [makeReviewResult({ verdict: "blocking", violations: [violation] })],
      }),
    };
    const adversarialBuild = {
      archive_id: "build-adversarial",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-adversarial",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [makeProvStep("adversarial-review", "canon:reviewer", [RULE_A_ID])],
        reviewResults: [makeReviewResult({ verdict: "blocking", violations: [violation] })],
      }),
    };

    const plainResult = aggregateOutcomes({
      builds: [plainBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
    });
    const adversarialResult = aggregateOutcomes({
      builds: [adversarialBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
    });

    const plainWeight = Math.abs(plainResult.scores[0].net_score);
    const adversarialWeight = Math.abs(adversarialResult.scores[0].net_score);
    expect(adversarialWeight).toBeGreaterThan(plainWeight);
  });
});

// ---------------------------------------------------------------------------
// 9. meta.decisions_seen
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — meta", () => {
  it("threads decisions.length into meta.decisions_seen without inspecting the entries", () => {
    const result = aggregateOutcomes({
      builds: [],
      decisions: [{ arbitrary: "shape" }, { another: "one" }],
      now_ms: 0,
      readCurrentBody,
    });

    expect(result.meta.decisions_seen).toBe(2);
    expect(result.meta.builds_seen).toBe(0);
    expect(result.scores).toEqual([]);
  });
});
