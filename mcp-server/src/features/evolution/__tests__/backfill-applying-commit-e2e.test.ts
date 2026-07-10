/**
 * backfill-applying-commit-e2e.test.ts
 *
 * END-TO-END integration coverage for Inc-3, beyond the 16 existing unit
 * tests (DAO backfill x6 in applied-evolutions-dao-backfill.test.ts + tool
 * x10 in backfill-applying-commit.test.ts, both against a mocked `gitExec`
 * and/or an isolated seam). This file drives the REAL `git` binary against a
 * scratch repo and the REAL drift.db (no mocks anywhere) — the genuine
 * gitExec -> parseEvolutionTrailers -> backfillApplyingCommit chain the unit
 * tests stub out (agent-integration-boundary-check).
 *
 * Uses the same `initGitRepo`-style real-repo fixture pattern established in
 * init-workspace-worktree.test.ts, and the same isolated-tmpdir-projectDir
 * discipline as backfill-applying-commit.test.ts (never process.cwd() —
 * drift-db-leak-guard would fail the suite otherwise).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordAppliedEvolutionInput } from "@platform/storage/drift/applied-evolutions-dao.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillApplyingCommit } from "../tools/backfill-applying-commit.ts";

// ---------------------------------------------------------------------------
// Real-git-repo fixture helpers
// ---------------------------------------------------------------------------

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "chore: init"], { cwd: dir });
}

/**
 * Create a real commit whose body carries a `Canon-Evolution:` trailer line,
 * exactly as the producer (review-learnings.md apply path) would write it via
 * `buildCommitMessage`/`formatCommitTrailers`. `fileTag` names a throwaway
 * file so each commit has a real diff to commit.
 */
function commitWithTrailer(
  dir: string,
  subject: string,
  trailerLine: string,
  fileTag: string,
): string {
  writeFileSync(join(dir, `${fileTag}.txt`), `${fileTag}\n`);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", subject, "-m", trailerLine], { cwd: dir });
  return headSha(dir);
}

/** A commit with no Canon-Evolution trailer at all — plumbing noise. */
function commitPlain(dir: string, subject: string, fileTag: string): string {
  writeFileSync(join(dir, `${fileTag}.txt`), `${fileTag}\n`);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", subject], { cwd: dir });
  return headSha(dir);
}

function headSha(dir: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return result.stdout.trim();
}

function seedRow(projectDir: string, overrides: Partial<RecordAppliedEvolutionInput> = {}): void {
  getDriftDb(projectDir)
    .getAppliedEvolutions()
    .record({
      after_hash: "after",
      applied_at: "2026-07-10T00:00:00.000Z",
      artifact_class: "rule",
      before_hash: "before",
      holdout_baseline: 10,
      holdout_candidate: 12,
      principle_id: "agent-tdd-required",
      proposal_id: "evolve-e2e-01",
      target_path: "rules/agent-tdd-required.md",
      ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("backfillApplyingCommit — real git + real drift.db round-trip", () => {
  let tmpProjectDir: string;

  beforeEach(() => {
    tmpProjectDir = mkdtempSync(join(tmpdir(), "backfill-e2e-test-"));
    initGitRepo(tmpProjectDir);
  });

  afterEach(() => {
    evictDriftDbForScope(tmpProjectDir);
    rmSync(tmpProjectDir, { force: true, recursive: true });
  });

  it("primary: populates applying_commit from a real commit's Canon-Evolution trailer", async () => {
    seedRow(tmpProjectDir);
    const sha = commitWithTrailer(
      tmpProjectDir,
      "chore(evolution): apply evolve-e2e-01",
      "Canon-Evolution: evolve-e2e-01",
      "apply-01",
    );

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(1);
      expect(result.scanned).toBe(1);
    }

    const row = getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-e2e-01");
    // Real HEAD sha (`git rev-parse HEAD`), not a fixture string — the actual
    // gitExec -> parseEvolutionTrailers -> DAO chain, not a mocked seam.
    expect(row?.applying_commit).toBe(sha);
  });

  it("sad path: a charset-invalid trailer value (embedded space) is skipped — row stays null, no crash", async () => {
    seedRow(tmpProjectDir);
    commitWithTrailer(
      tmpProjectDir,
      "chore(evolution): apply with a bad id",
      "Canon-Evolution: evil id with spaces",
      "apply-bad-space",
    );

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(0);
    }
    expect(
      getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-e2e-01")
        ?.applying_commit,
    ).toBeNull();
  });

  it("sad path: a charset-invalid trailer value (disallowed char, single token) is skipped by the dc-05 guard", async () => {
    seedRow(tmpProjectDir);
    // Single non-whitespace token so it passes the trailer LINE regex, but
    // the embedded "/" fails PROPOSAL_ID_CHARSET (^[A-Za-z0-9._-]+$) — this
    // exercises the charset guard itself, not just the line-shape regex.
    commitWithTrailer(
      tmpProjectDir,
      "chore(evolution): apply with a slash id",
      "Canon-Evolution: evil/id",
      "apply-bad-slash",
    );

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(0);
    }
    expect(
      getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-e2e-01")
        ?.applying_commit,
    ).toBeNull();
  });

  it("sad path: zero Canon-Evolution commits in history -> clean no-op { updated: 0, scanned: 0 }", async () => {
    seedRow(tmpProjectDir);
    commitPlain(tmpProjectDir, "chore: unrelated commit", "unrelated-01");
    commitPlain(tmpProjectDir, "fix: another unrelated commit", "unrelated-02");

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(0);
      expect(result.scanned).toBe(0);
    }
    expect(
      getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-e2e-01")
        ?.applying_commit,
    ).toBeNull();
  });

  it("idempotent: re-running backfill after a successful populate is a no-op (updated: 0, value preserved)", async () => {
    seedRow(tmpProjectDir);
    const sha = commitWithTrailer(
      tmpProjectDir,
      "chore(evolution): apply evolve-e2e-01",
      "Canon-Evolution: evolve-e2e-01",
      "apply-01",
    );

    const first = await backfillApplyingCommit({ project_dir: tmpProjectDir });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.updated).toBe(1);

    const second = await backfillApplyingCommit({ project_dir: tmpProjectDir });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.updated).toBe(0); // null-only guard: already-populated row is untouched
      expect(second.scanned).toBe(1); // the trailer is still scanned — only the write is a no-op
    }

    expect(
      getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-e2e-01")
        ?.applying_commit,
    ).toBe(sha);
  });

  it("no cross-attribution: two evolutions, only one committed -> only the committed row is populated", async () => {
    seedRow(tmpProjectDir, { proposal_id: "evolve-e2e-a" });
    seedRow(tmpProjectDir, {
      proposal_id: "evolve-e2e-b",
      target_path: "rules/agent-test-sad-paths.md",
    });

    const shaA = commitWithTrailer(
      tmpProjectDir,
      "chore(evolution): apply evolve-e2e-a",
      "Canon-Evolution: evolve-e2e-a",
      "apply-a",
    );

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(1);
      expect(result.scanned).toBe(1);
    }

    const dao = getDriftDb(tmpProjectDir).getAppliedEvolutions();
    expect(dao.getByProposalId("evolve-e2e-a")?.applying_commit).toBe(shaA);
    expect(dao.getByProposalId("evolve-e2e-b")?.applying_commit).toBeNull();
  });
});
