/**
 * get-evolution-outcomes.test.ts — get_evolution_outcomes handler integration tests.
 *
 * Uses a real file-backed drift.db under a temp project dir. Covers:
 * (a) pre/post cohort split on seeded reviews⋈violations (principle signal)
 * (b) agent-def cliff path on seeded cliff_events
 * (c) insufficient verdict on a sparse cohort side
 * (d) ambiguous verdict on overlapping confounds (same signal)
 * (e) PROPOSAL_NOT_RECORDED + INVALID_INPUT error paths
 * (f) fail-open: empty signal → insufficient verdict, not an error
 * (g) vocabulary grep — the tool source has zero caus(e|ed|es) matches
 *
 * Canon principles:
 *   - errors-are-values: handler returns ToolResult, never throws.
 *   - fail-open reads with typed insufficient/ambiguous buckets.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewEntry } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import {
  evictDriftDbForScope,
  getDriftDb,
} from "../../../platform/storage/drift/drift-db-cache.ts";
import { getEvolutionOutcomes } from "../tools/get-evolution-outcomes.ts";

let tmpProjectDir: string;
let db: DriftDb;

const ANCHOR = "2026-07-02T00:00:00.000Z";
const PRINCIPLE = "agent-tdd-required";

function seedReview(opts: {
  reviewId: string;
  timestamp: string;
  principleId: string;
  violationCount: number;
}): void {
  const violations: ReviewEntry["violations"] = Array.from({ length: opts.violationCount }, () => ({
    principle_id: opts.principleId,
    severity: "warning",
  }));
  const entry: ReviewEntry = {
    files: ["src/x.ts"],
    honored: [],
    review_id: opts.reviewId,
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    },
    timestamp: opts.timestamp,
    verdict: opts.violationCount > 0 ? "BLOCKING" : "CLEAN",
    violations,
  };
  db.appendReview(entry);
}

function recordProposal(opts: {
  proposalId: string;
  appliedAt?: string;
  principleId?: string | null;
  targetPath?: string;
  artifactClass?: string;
}): void {
  db.getAppliedEvolutions().record({
    after_hash: "sha-after",
    applied_at: opts.appliedAt ?? ANCHOR,
    apply_base_commit: "abc123",
    artifact_class: opts.artifactClass ?? "rule",
    before_hash: "sha-before",
    holdout_baseline: 10,
    holdout_candidate: 12,
    principle_id: opts.principleId === undefined ? PRINCIPLE : opts.principleId,
    proposal_id: opts.proposalId,
    target_path: opts.targetPath ?? "rules/agent-tdd-required.md",
  });
}

beforeEach(() => {
  tmpProjectDir = mkdtempSync(join(tmpdir(), "get-evo-outcomes-"));
  db = getDriftDb(tmpProjectDir);
});

afterEach(() => {
  evictDriftDbForScope(tmpProjectDir);
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("(a) principle signal — pre/post cohort split", () => {
  it("splits reviews⋈violations on applied_at and computes a delta", async () => {
    recordProposal({ proposalId: "evolve-a" });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r1",
      timestamp: "2026-06-30T00:00:00.000Z",
      violationCount: 1,
    });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r2",
      timestamp: "2026-07-01T00:00:00.000Z",
      violationCount: 1,
    });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r3",
      timestamp: "2026-07-03T00:00:00.000Z",
      violationCount: 3,
    });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r4",
      timestamp: "2026-07-04T00:00:00.000Z",
      violationCount: 3,
    });

    const res = await getEvolutionOutcomes({ project_dir: tmpProjectDir, proposal_id: "evolve-a" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.signal).toBe("review_violation");
    expect(res.cohort.pre.events).toBe(2);
    expect(res.cohort.post.events).toBe(6);
    expect(res.cohort.pre.rate).toBeCloseTo(1);
    expect(res.cohort.post.rate).toBeCloseTo(3);
    expect(res.delta).toBeCloseTo(2);
    expect(res.ambiguous).toBe(false);
  });
});

describe("(b) agent-def cliff signal", () => {
  it("splits cliff_events by derived agent_type and normalizes canon: prefix", async () => {
    recordProposal({
      artifactClass: "agent",
      principleId: null,
      proposalId: "evolve-b",
      targetPath: "agents/engineer.md",
    });
    const cliffs = db.getCliffEvents();
    cliffs.upsert({
      agent_type: "engineer",
      detected_at: "2026-07-01T00:00:00.000Z",
      source: "resume",
      step_id: "s1",
      workspace_slug: "w1",
    });
    cliffs.upsert({
      agent_type: "reviewer",
      detected_at: "2026-07-01T00:00:00.000Z",
      source: "resume",
      step_id: "s2",
      workspace_slug: "w2",
    });
    cliffs.upsert({
      agent_type: "canon:engineer",
      detected_at: "2026-07-03T00:00:00.000Z",
      source: "resume",
      step_id: "s3",
      workspace_slug: "w3",
    });
    cliffs.upsert({
      agent_type: "engineer",
      detected_at: "2026-07-04T00:00:00.000Z",
      source: "resume",
      step_id: "s4",
      workspace_slug: "w4",
    });
    cliffs.upsert({
      agent_type: "reviewer",
      detected_at: "2026-07-03T00:00:00.000Z",
      source: "resume",
      step_id: "s5",
      workspace_slug: "w5",
    });

    const res = await getEvolutionOutcomes({ project_dir: tmpProjectDir, proposal_id: "evolve-b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.signal).toBe("cliff_event");
    expect(res.cohort.pre.events).toBe(1); // engineer pre
    expect(res.cohort.post.events).toBe(2); // engineer + canon:engineer post
    expect(res.principle_id).toBeNull();
  });
});

describe("(c) insufficient on sparse cohort", () => {
  it("floors to insufficient when either side has < 5 events", async () => {
    recordProposal({ proposalId: "evolve-c" });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r1",
      timestamp: "2026-07-01T00:00:00.000Z",
      violationCount: 1,
    });
    seedReview({
      principleId: PRINCIPLE,
      reviewId: "r2",
      timestamp: "2026-07-03T00:00:00.000Z",
      violationCount: 2,
    });

    const res = await getEvolutionOutcomes({ project_dir: tmpProjectDir, proposal_id: "evolve-c" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.confidence.tier).toBe("insufficient");
    expect(res.verdict).toBe("insufficient");
  });
});

describe("(d) ambiguous on overlapping confounds", () => {
  it("flags ambiguous with both confounding proposal ids when a concurrent apply touches the same signal", async () => {
    recordProposal({ appliedAt: ANCHOR, proposalId: "evolve-d1" });
    recordProposal({ appliedAt: "2026-07-03T00:00:00.000Z", proposalId: "evolve-d2" });

    const res = await getEvolutionOutcomes({
      project_dir: tmpProjectDir,
      proposal_id: "evolve-d1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ambiguous).toBe(true);
    expect(res.confounding_proposal_ids).toContain("evolve-d2");
    expect(res.verdict).toBe("ambiguous");
  });

  it("does not flag a concurrent apply on a DIFFERENT signal as a confound", async () => {
    recordProposal({ appliedAt: ANCHOR, proposalId: "evolve-d1", principleId: PRINCIPLE });
    recordProposal({
      appliedAt: "2026-07-03T00:00:00.000Z",
      principleId: "other-principle",
      proposalId: "evolve-other",
    });

    const res = await getEvolutionOutcomes({
      project_dir: tmpProjectDir,
      proposal_id: "evolve-d1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ambiguous).toBe(false);
  });
});

describe("(e) error paths", () => {
  it("returns INVALID_INPUT for an empty proposal_id", async () => {
    const res = await getEvolutionOutcomes({ project_dir: tmpProjectDir, proposal_id: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe("INVALID_INPUT");
  });

  it("returns PROPOSAL_NOT_RECORDED for an unknown proposal_id", async () => {
    const res = await getEvolutionOutcomes({
      project_dir: tmpProjectDir,
      proposal_id: "never-applied",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe("PROPOSAL_NOT_RECORDED");
  });
});

describe("(f) fail-open on empty signal", () => {
  it("yields cohort zeros + insufficient verdict, not an error, when no signal rows exist", async () => {
    recordProposal({ proposalId: "evolve-f", principleId: "principle-with-no-reviews" });
    const res = await getEvolutionOutcomes({ project_dir: tmpProjectDir, proposal_id: "evolve-f" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cohort.pre.events).toBe(0);
    expect(res.cohort.post.events).toBe(0);
    expect(res.verdict).toBe("insufficient");
  });
});

describe("(g) vocabulary constraint", () => {
  it("the tool source contains zero caus(e|ed|es) matches (candidate-cause vocabulary only)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../tools/get-evolution-outcomes.ts", import.meta.url)),
      "utf-8",
    );
    expect(/caus(e|ed|es)/i.test(src)).toBe(false);
  });
});
