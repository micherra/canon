/**
 * outcome-attribution-corpus-fallback.test.ts — aggregateOutcomes' corpus-fallback
 * join seam (ADR-0062, Bug-1 part (d)). Split out of outcome-attribution.test.ts on
 * file-length grounds (noExcessiveLinesPerFile) — same pattern as
 * evaluate-candidate-holistic-gate.test.ts.
 *
 * Covers (per bug1-02-PLAN.md "Tests to write"):
 * - fallback contribution accumulates positive weight at the floor (strictly less
 *   than a provenance-joined twin)
 * - a two-sided score moves toward positive for a principle with honored-citation
 *   fixtures once the seam is supplied
 * - determinism dc-01 holds with the seam
 * - seam absent -> a no-provenance honored citation stays unattributed with
 *   no_corpus_artifact (prior behavior byte-for-byte)
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed
 *   - errors-are-values: lossy paths are typed buckets, never thrown
 */

import { describe, expect, it } from "vitest";
import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import type { ReviewResult, RunSummary } from "../../../platform/storage/archive/archive-types.ts";
import { aggregateOutcomes } from "../services/outcome-attribution.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors outcome-attribution.test.ts's fixture shapes)
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
// Corpus-fallback join seam (ADR-0062, Bug-1 part (d))
// ---------------------------------------------------------------------------

describe("aggregateOutcomes — corpus-fallback join seam", () => {
  const resolveCorpusArtifact = (id: string) =>
    id === RULE_A_ID
      ? { artifact_class: "rule" as const, body: RULE_A_BODY, path: RULE_A_PATH }
      : null;

  it("a fallback contribution (no provenance) accumulates positive weight strictly less than a provenance-joined twin", () => {
    const noProvenanceBuild = {
      archive_id: "build-no-prov",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-no-prov",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [], // no provenance at all -> fallback fires
        reviewResults: [
          makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] }),
        ],
      }),
    };
    const provenanceBuild = {
      archive_id: "build-prov",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-prov",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [makeProvStep("review", "canon:reviewer", [RULE_A_ID])],
        reviewResults: [
          makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] }),
        ],
      }),
    };

    const fallbackResult = aggregateOutcomes({
      builds: [noProvenanceBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
      resolveCorpusArtifact,
    });
    const provenanceResult = aggregateOutcomes({
      builds: [provenanceBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
      resolveCorpusArtifact,
    });

    expect(fallbackResult.scores).toHaveLength(1);
    expect(provenanceResult.scores).toHaveLength(1);
    expect(fallbackResult.scores[0].net_score).toBeGreaterThan(0);
    expect(fallbackResult.scores[0].net_score).toBeLessThan(provenanceResult.scores[0].net_score);
  });

  it("a two-sided score moves toward positive for a principle with honored-citation fixtures once the seam is supplied", () => {
    const honoringNoProvBuild = {
      archive_id: "build-honor-no-prov",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-honor-no-prov",
        completedAt: "2026-01-02T00:00:00.000Z",
        contextProvenance: [],
        reviewResults: [
          makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] }),
        ],
      }),
    };
    const violatingBuild = {
      archive_id: "build-violate",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-violate",
        completedAt: "2026-01-01T00:00:00.000Z",
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

    const withoutSeam = aggregateOutcomes({
      builds: [honoringNoProvBuild, violatingBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-02T00:00:00.000Z"),
      readCurrentBody,
    });
    const withSeam = aggregateOutcomes({
      builds: [honoringNoProvBuild, violatingBuild],
      decisions: [],
      now_ms: Date.parse("2026-01-02T00:00:00.000Z"),
      readCurrentBody,
      resolveCorpusArtifact,
    });

    // Without the seam, the honored citation with no provenance is simply unattributed —
    // only the violation scores, so net_score is negative.
    expect(withoutSeam.scores).toHaveLength(1);
    expect(withoutSeam.scores[0].net_score).toBeLessThan(0);
    expect(withoutSeam.unattributed_positive).toHaveLength(1);
    expect(withoutSeam.unattributed_positive[0].reason).toBe("no_corpus_artifact");

    // With the seam, the honored citation resolves via corpus fallback and its (floor-
    // weighted) positive contribution moves net_score upward relative to the no-seam run.
    expect(withSeam.scores).toHaveLength(1);
    expect(withSeam.scores[0].net_score).toBeGreaterThan(withoutSeam.scores[0].net_score);
  });

  it("determinism (dc-01) holds with the seam supplied", () => {
    const build = {
      archive_id: "build-1",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-1",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [],
        reviewResults: [
          makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] }),
        ],
      }),
    };

    const input = {
      builds: [build],
      decisions: [],
      now_ms: Date.parse("2026-01-05T00:00:00.000Z"),
      readCurrentBody,
      resolveCorpusArtifact,
    };

    const first = aggregateOutcomes(input);
    const second = aggregateOutcomes(input);
    expect(second).toEqual(first);
  });

  it("seam absent -> a no-provenance honored citation stays unattributed with no_corpus_artifact", () => {
    const build = {
      archive_id: "build-1",
      cliffEvents: [],
      summary: makeRunSummary({
        archiveId: "build-1",
        completedAt: "2026-01-01T00:00:00.000Z",
        contextProvenance: [],
        reviewResults: [
          makeReviewResult({ verdict: "clean", honored: [`**${RULE_A_ID}**: good`] }),
        ],
      }),
    };

    const result = aggregateOutcomes({
      builds: [build],
      decisions: [],
      now_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      readCurrentBody,
    });

    expect(result.scores).toEqual([]);
    expect(result.unattributed_positive).toHaveLength(1);
    expect(result.unattributed_positive[0].reason).toBe("no_corpus_artifact");
  });
});
