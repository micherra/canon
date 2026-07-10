/**
 * backfill-applying-commit.test.ts
 *
 * Tests for backfill_applying_commit — Inc-3 back-fill of
 * applied_evolutions.applying_commit from Canon-Evolution: git trailers.
 *
 * Mirrors the mock strategy used by forecast-base-advance.test.ts: mock
 * @platform/adapters/git-adapter.ts (gitExec) to control git-log output, and
 * use the REAL getDriftDb against an isolated tmp project_dir so the DAO's
 * null-only UPDATE is genuinely exercised (never process.cwd()).
 *
 * Covers:
 * 1. parseEvolutionTrailers — pure unit tests (happy path + charset-skip + dedupe)
 * 2. Handler happy path — seeded row updated, returns { updated, scanned }
 * 3. Handler INVALID_INPUT — empty project_dir
 * 4. Handler fail-safe — git failure returns a ToolResult error, never throws
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi.fn(),
}));

import { gitExec } from "@platform/adapters/git-adapter.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import {
  backfillApplyingCommit,
  parseEvolutionTrailers,
} from "../tools/backfill-applying-commit.ts";

const mockGitExec = vi.mocked(gitExec);

function commitBlock(sha: string, body: string): string {
  return `${sha}\n${body}\n==END==`;
}

// ---------------------------------------------------------------------------
// parseEvolutionTrailers — pure unit tests
// ---------------------------------------------------------------------------

describe("parseEvolutionTrailers", () => {
  it("extracts a single {proposal_id, sha} pair from one commit block", () => {
    const logText = commitBlock(
      "abc123",
      "chore(evolution): apply evolve-01\n\nCanon-Workflow: evolution-apply\nCanon-Evolution: evolve-01",
    );

    expect(parseEvolutionTrailers(logText)).toEqual([
      { applying_commit: "abc123", proposal_id: "evolve-01" },
    ]);
  });

  it("extracts pairs from multiple commit blocks", () => {
    const logText = [
      commitBlock("sha1", "chore(evolution): apply p-1\n\nCanon-Evolution: p-1"),
      commitBlock("sha2", "chore(evolution): apply p-2\n\nCanon-Evolution: p-2"),
    ].join("\n");

    expect(parseEvolutionTrailers(logText)).toEqual([
      { applying_commit: "sha1", proposal_id: "p-1" },
      { applying_commit: "sha2", proposal_id: "p-2" },
    ]);
  });

  it("skips a charset-invalid trailer value containing a space", () => {
    const logText = commitBlock(
      "sha-bad",
      "chore(evolution): apply\n\nCanon-Evolution: evil id with spaces",
    );

    expect(parseEvolutionTrailers(logText)).toEqual([]);
  });

  it("dedupes by proposal_id, keeping the first-seen (newest, git-log order) sha", () => {
    const logText = [
      commitBlock("sha-newest", "Canon-Evolution: p-1"),
      commitBlock("sha-older", "Canon-Evolution: p-1"),
    ].join("\n");

    expect(parseEvolutionTrailers(logText)).toEqual([
      { applying_commit: "sha-newest", proposal_id: "p-1" },
    ]);
  });

  it("returns [] for empty log text", () => {
    expect(parseEvolutionTrailers("")).toEqual([]);
  });

  it("returns [] when no commit carries a Canon-Evolution trailer", () => {
    const logText = commitBlock("sha1", "chore: unrelated commit\n\nCanon-Workflow: other");
    expect(parseEvolutionTrailers(logText)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// backfillApplyingCommit handler — integration tests
// ---------------------------------------------------------------------------

describe("backfillApplyingCommit handler", () => {
  let tmpProjectDir: string;

  beforeEach(() => {
    tmpProjectDir = mkdtempSync(join(tmpdir(), "backfill-applying-commit-test-"));
    mockGitExec.mockReset();
  });

  afterEach(() => {
    evictDriftDbForScope(tmpProjectDir);
    rmSync(tmpProjectDir, { force: true, recursive: true });
  });

  it("happy path: updates a seeded drift.db row and returns { updated, scanned }", async () => {
    getDriftDb(tmpProjectDir).getAppliedEvolutions().record({
      after_hash: "after",
      applied_at: "2026-07-10T00:00:00.000Z",
      artifact_class: "rule",
      before_hash: "before",
      holdout_baseline: 10,
      holdout_candidate: 12,
      principle_id: "agent-tdd-required",
      proposal_id: "evolve-20260710-01",
      target_path: "rules/agent-tdd-required.md",
    });

    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: commitBlock("sha-abc", "Canon-Evolution: evolve-20260710-01"),
      timedOut: false,
    });

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(1);
      expect(result.scanned).toBe(1);
    }
    const row = getDriftDb(tmpProjectDir)
      .getAppliedEvolutions()
      .getByProposalId("evolve-20260710-01");
    expect(row?.applying_commit).toBe("sha-abc");
  });

  it("no matching trailers: returns { updated: 0, scanned: 0 } — plumbing-only no-op", async () => {
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    });

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated).toBe(0);
      expect(result.scanned).toBe(0);
    }
  });

  it("INVALID_INPUT on empty project_dir", async () => {
    const result = await backfillApplyingCommit({ project_dir: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it("fail-safe: a git log failure returns a ToolResult error, never throws", async () => {
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 128,
      ok: false,
      stderr: "fatal: not a git repository",
      stdout: "",
      timedOut: false,
    });

    const result = await backfillApplyingCommit({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
      expect(result.message).toContain("git log failed");
    }
  });

  // ---------------------------------------------------------------------------
  // max_commits validation (Codex P2 on #484) — rejected BEFORE git is invoked
  // ---------------------------------------------------------------------------

  it("rejects max_commits: -1 with INVALID_INPUT, never invoking git", async () => {
    const result = await backfillApplyingCommit({ max_commits: -1, project_dir: tmpProjectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it("rejects max_commits: 0 with INVALID_INPUT, never invoking git", async () => {
    const result = await backfillApplyingCommit({ max_commits: 0, project_dir: tmpProjectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it("rejects a max_commits value beyond the upper cap with INVALID_INPUT, never invoking git", async () => {
    const result = await backfillApplyingCommit({
      max_commits: 100_001,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it("accepts a valid positive max_commits and reaches git", async () => {
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    });

    const result = await backfillApplyingCommit({ max_commits: 50, project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    expect(mockGitExec).toHaveBeenCalledWith(expect.arrayContaining(["-n", "50"]), tmpProjectDir);
  });
});
