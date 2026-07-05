/**
 * decisions-corpus.test.ts
 *
 * Tests for buildDecisionsCorpus / aggregateDecisions / renderCorpus — the
 * offline cross-workspace decisions reader + aggregator (ADR-0038, T-02).
 *
 * Test plan (T-02-PLAN.md, drift-db-leak-guard convention: isolated mkdtemp
 * projectDir, never process.cwd()):
 * - union of a live fixture store + durable DAO rows
 * - deterministic sort (decided_at, then source_slug, then source_event_id)
 * - aggregateDecisions effective-category bucketing (gate-discriminator)
 * - fill-rate math
 * - malformed store -> skipped[]
 * - no-overlap union count (a workspace present live is not also durable)
 * - two runs over the same fixtures produce byte-identical decisions order + rendered
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateDecisions, buildDecisionsCorpus, renderCorpus } from "../decisions-corpus.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

/** Create a live workspace fixture at .canon/workspaces/{branch}/{slug}/orchestration.db. */
function seedLiveWorkspace(
  projectDir: string,
  branch: string,
  slug: string,
  decisions: Array<{ decision_type: string; summary: string; gate?: string; decided_at?: string }>,
): string {
  const workspaceDir = join(projectDir, CANON_DIR, "workspaces", branch, slug);
  mkdirSync(workspaceDir, { recursive: true });
  const store = getExecutionStore(workspaceDir);
  for (const d of decisions) {
    store.appendEvent("orchestrator_decision", {
      decision_type: d.decision_type,
      gate: d.gate,
      summary: d.summary,
      timestamp: d.decided_at ?? new Date().toISOString(),
    });
  }
  return join(workspaceDir, CANON_FILES.ORCHESTRATION_DB);
}

/** Write a durable orchestrator_decisions row via the real DAO. */
function seedDurable(
  projectDir: string,
  slug: string,
  decisions: Array<{
    decision_type: string;
    summary: string;
    gate?: string;
    decided_at?: string;
    source_event_id?: number;
  }>,
): void {
  getDriftDb(projectDir)
    .getOrchestratorDecisions()
    .persistMany(
      slug,
      decisions.map((d, i) => ({
        decided_at: d.decided_at ?? new Date().toISOString(),
        decision_type: d.decision_type,
        gate: d.gate,
        source_event_id: d.source_event_id ?? i + 1,
        summary: d.summary,
      })),
    );
}

describe("buildDecisionsCorpus — union", () => {
  it("unions a live fixture store with durable DAO rows", () => {
    const projectDir = makeTmpDir("decisions-corpus-union-");
    seedLiveWorkspace(projectDir, "main", "live-slug", [
      { decision_type: "scope_cut", summary: "Cut the reader from wave 1" },
    ]);
    seedDurable(projectDir, "durable-slug", [
      { decision_type: "other", summary: "Persisted after reap" },
    ]);

    const { decisions, skipped } = buildDecisionsCorpus(projectDir);

    expect(skipped).toEqual([]);
    expect(decisions).toHaveLength(2);
    expect(decisions.find((d) => d.source_slug === "live-slug")?.source).toBe("live");
    expect(decisions.find((d) => d.source_slug === "durable-slug")?.source).toBe("durable");
  });

  it("returns an empty corpus when .canon/workspaces is absent and no durable rows exist", () => {
    const projectDir = makeTmpDir("decisions-corpus-empty-");

    const { decisions, skipped } = buildDecisionsCorpus(projectDir);

    expect(decisions).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("a workspace present live is not also present in the durable table (no double count)", () => {
    const projectDir = makeTmpDir("decisions-corpus-no-overlap-");
    seedLiveWorkspace(projectDir, "main", "live-only-slug", [
      { decision_type: "scope_cut", summary: "Live decision one" },
      { decision_type: "ac_change", summary: "Live decision two" },
    ]);
    seedDurable(projectDir, "durable-only-slug", [
      { decision_type: "other", summary: "Durable decision one" },
    ]);

    const { decisions } = buildDecisionsCorpus(projectDir);

    const liveOnly = decisions.filter((d) => d.source_slug === "live-only-slug");
    const durableOnly = decisions.filter((d) => d.source_slug === "durable-only-slug");
    expect(liveOnly).toHaveLength(2);
    expect(liveOnly.every((d) => d.source === "live")).toBe(true);
    expect(durableOnly).toHaveLength(1);
    expect(durableOnly.every((d) => d.source === "durable")).toBe(true);
    expect(decisions).toHaveLength(3);
  });
});

describe("buildDecisionsCorpus — deterministic sort", () => {
  it("sorts by decided_at, then source_slug, then source_event_id", () => {
    const projectDir = makeTmpDir("decisions-corpus-sort-");
    seedLiveWorkspace(projectDir, "main", "slug-b", [
      { decided_at: "2026-07-01T10:00:00.000Z", decision_type: "other", summary: "b-first" },
      { decided_at: "2026-07-01T09:00:00.000Z", decision_type: "other", summary: "b-second" },
    ]);
    seedDurable(projectDir, "slug-a", [
      { decided_at: "2026-07-01T09:00:00.000Z", decision_type: "other", summary: "a-first" },
    ]);

    const { decisions } = buildDecisionsCorpus(projectDir);

    // Both "b-second" (slug-b, 09:00) and "a-first" (slug-a, 09:00) share decided_at;
    // slug-a sorts before slug-b alphabetically.
    const summaries = decisions.map((d) => d.summary);
    expect(summaries).toEqual(["a-first", "b-second", "b-first"]);
  });
});

describe("buildDecisionsCorpus — schema skew / malformed stores", () => {
  it("an unreadable store lands in skipped[] while other stores still return", () => {
    const projectDir = makeTmpDir("decisions-corpus-malformed-");
    seedLiveWorkspace(projectDir, "main", "good-slug", [
      { decision_type: "other", summary: "readable decision" },
    ]);

    const malformedDir = join(projectDir, CANON_DIR, "workspaces", "main", "malformed-slug");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, CANON_FILES.ORCHESTRATION_DB), "not a real sqlite file");

    const { decisions, skipped } = buildDecisionsCorpus(projectDir);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].source_slug).toBe("good-slug");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toContain("malformed-slug");
    expect(skipped[0].reason).toBeTruthy();
  });
});

describe("buildDecisionsCorpus — non-determinism guard", () => {
  it("two runs over the same fixtures produce byte-identical decisions order and rendered output", () => {
    const projectDir = makeTmpDir("decisions-corpus-determinism-");
    seedLiveWorkspace(projectDir, "main", "slug-1", [
      { decision_type: "scope_cut", summary: "One" },
      { decision_type: "ac_change", summary: "Two" },
    ]);
    seedDurable(projectDir, "slug-2", [{ decision_type: "other", summary: "Three" }]);

    const first = buildDecisionsCorpus(projectDir);
    const second = buildDecisionsCorpus(projectDir);

    expect(second.decisions).toEqual(first.decisions);

    const firstAgg = aggregateDecisions(first.decisions);
    const secondAgg = aggregateDecisions(second.decisions);
    expect(renderCorpus(second.decisions, secondAgg)).toBe(renderCorpus(first.decisions, firstAgg));
  });
});

describe("aggregateDecisions — effective category (gate-discriminator)", () => {
  it("buckets hitl_gate decisions by gate, not the undifferentiated decision_type", () => {
    const records = [
      {
        decided_at: "2026-07-01T09:00:00.000Z",
        decision_type: "hitl_gate",
        gate: "review_verdict",
        source: "live" as const,
        source_event_id: 1,
        source_slug: "slug-1",
        summary: "Review verdict accepted",
      },
      {
        decided_at: "2026-07-01T09:01:00.000Z",
        decision_type: "hitl_gate",
        gate: "plan_approval",
        source: "live" as const,
        source_event_id: 2,
        source_slug: "slug-1",
        summary: "Plan approved",
      },
    ];

    const agg = aggregateDecisions(records);

    expect(agg.by_category.review_verdict).toBe(1);
    expect(agg.by_category.plan_approval).toBe(1);
    expect(agg.by_category.hitl_gate).toBeUndefined();
    expect(agg.by_decision_type.hitl_gate).toBe(2);
  });

  it("falls back to decision_type when gate is absent", () => {
    const records = [
      {
        decided_at: "2026-07-01T09:00:00.000Z",
        decision_type: "scope_cut",
        source: "live" as const,
        source_event_id: 1,
        source_slug: "slug-1",
        summary: "Cut something",
      },
    ];

    const agg = aggregateDecisions(records);

    expect(agg.by_category.scope_cut).toBe(1);
  });
});

describe("aggregateDecisions — fill rates", () => {
  it("computes the fraction of non-empty rationale/outcome/gate/refs", () => {
    const records = [
      {
        decided_at: "2026-07-01T09:00:00.000Z",
        decision_type: "other",
        gate: "plan_approval",
        outcome: "approved",
        rationale: "because it was correct",
        refs: ["AC#1"],
        source: "live" as const,
        source_event_id: 1,
        source_slug: "slug-1",
        summary: "One with everything",
      },
      {
        decided_at: "2026-07-01T09:01:00.000Z",
        decision_type: "other",
        source: "live" as const,
        source_event_id: 2,
        source_slug: "slug-1",
        summary: "One with nothing else",
      },
    ];

    const agg = aggregateDecisions(records);

    expect(agg.total).toBe(2);
    expect(agg.fill_rates.rationale).toBe(0.5);
    expect(agg.fill_rates.outcome).toBe(0.5);
    expect(agg.fill_rates.gate).toBe(0.5);
    expect(agg.fill_rates.refs).toBe(0.5);
  });

  it("returns zero rates for an empty corpus, never NaN", () => {
    const agg = aggregateDecisions([]);

    expect(agg.total).toBe(0);
    expect(agg.fill_rates).toEqual({ gate: 0, outcome: 0, rationale: 0, refs: 0 });
  });
});

describe("renderCorpus", () => {
  it("renders a placeholder for an empty corpus", () => {
    const rendered = renderCorpus([], aggregateDecisions([]));
    expect(rendered).toContain("0");
  });
});
