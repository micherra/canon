/**
 * forecast-base-advance — unit tests for the pure core, integration tests for the handler.
 *
 * Tests cover:
 *  1. Pure core (`computeBaseAdvanceForecast`) — no I/O, AC#1-3 branches:
 *     - commits_ahead === 0 → silent (AC#3)
 *     - direct overlap → advisory fires, reason: "direct" (AC#1/AC#2)
 *     - co-change overlap → advisory fires, reason: "co-change" with partner+jaccard (AC#1/AC#2)
 *     - commits_ahead > 0 but no overlap → silent (AC#3)
 *     - direct + co-change on same file → deduped, direct wins
 *  2. Handler (`forecastBaseAdvance`) — real seams, isolated tmp projectDir:
 *     - happy path: direct overlap via mocked gitExec, KG absent (existsSync false)
 *     - happy path: co-change overlap via mocked gitExec + a real temp KG db
 *     - fail-safe: gitExec rev-list failure → silent toolOk result, never throws
 *     - KG absent: direct-overlap path still returns a valid result
 *
 * Mock strategy:
 *  - Mock @platform/adapters/git-adapter.ts (gitExec) — control commits_ahead / mainChanged.
 *  - Mock @features/knowledge-graph/git-intel/git-intel-pipeline.ts (ensureGitIntelFresh) — no-op,
 *    avoids running the real git-log-parsing pipeline in tests.
 *  - Use the REAL @graph/kg-schema.ts initDatabase against an isolated tmp file so the
 *    co_change_edges SQL query is genuinely exercised (never process.cwd()).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi.fn(),
}));

vi.mock("@features/knowledge-graph/git-intel/git-intel-pipeline.ts", () => ({
  ensureGitIntelFresh: vi.fn(),
}));

import { initDatabase } from "@graph/kg-schema.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { computeBaseAdvanceForecast, forecastBaseAdvance } from "../tools/forecast-base-advance.ts";

const mockGitExec = vi.mocked(gitExec);

// ---- Pure core (no I/O) ----

describe("computeBaseAdvanceForecast", () => {
  it("is silent when commits_ahead === 0 (AC#3)", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 0,
      coPartners: new Map(),
      declaredFiles: ["src/a.ts"],
      mainChangedFiles: ["src/a.ts"],
    });

    expect(result).toEqual({
      advisory: null,
      commits_ahead: 0,
      overlapping_files: [],
    });
  });

  it("fires the advisory on direct overlap", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 3,
      coPartners: new Map(),
      declaredFiles: ["src/a.ts", "src/b.ts"],
      mainChangedFiles: ["src/a.ts"],
    });

    expect(result.commits_ahead).toBe(3);
    expect(result.overlapping_files).toEqual([{ file: "src/a.ts", reason: "direct" }]);
    expect(result.advisory).not.toBeNull();
    expect(result.advisory).toContain("3 commit(s)");
    expect(result.advisory).toContain("src/a.ts");
  });

  it("fires the advisory on co-change overlap (partner not itself changed)", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 1,
      coPartners: new Map([
        ["src/main-changed.ts", [{ jaccard: 0.75, partner: "src/partner.ts" }]],
      ]),
      declaredFiles: ["src/partner.ts"],
      mainChangedFiles: ["src/main-changed.ts"],
    });

    expect(result.overlapping_files).toEqual([
      {
        file: "src/partner.ts",
        jaccard: 0.75,
        partner: "src/main-changed.ts",
        reason: "co-change",
      },
    ]);
    expect(result.advisory).not.toBeNull();
    expect(result.advisory).toContain("src/partner.ts");
  });

  it("is silent when commits_ahead > 0 but there is no overlap (AC#3)", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 5,
      coPartners: new Map(),
      declaredFiles: ["src/unrelated.ts"],
      mainChangedFiles: ["src/other.ts"],
    });

    expect(result).toEqual({
      advisory: null,
      commits_ahead: 5,
      overlapping_files: [],
    });
  });

  it("dedups direct + co-change on the same declared file — direct wins", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 2,
      coPartners: new Map([["src/other.ts", [{ jaccard: 0.9, partner: "src/a.ts" }]]]),
      declaredFiles: ["src/a.ts"],
      mainChangedFiles: ["src/a.ts", "src/other.ts"],
    });

    expect(result.overlapping_files).toEqual([{ file: "src/a.ts", reason: "direct" }]);
  });

  it("keeps the highest jaccard when a file has multiple co-change partner matches", () => {
    const result = computeBaseAdvanceForecast({
      commitsAhead: 1,
      coPartners: new Map([
        ["src/m1.ts", [{ jaccard: 0.4, partner: "src/partner.ts" }]],
        ["src/m2.ts", [{ jaccard: 0.9, partner: "src/partner.ts" }]],
      ]),
      declaredFiles: ["src/partner.ts"],
      mainChangedFiles: ["src/m1.ts", "src/m2.ts"],
    });

    expect(result.overlapping_files).toHaveLength(1);
    expect(result.overlapping_files[0]).toMatchObject({ jaccard: 0.9, partner: "src/m2.ts" });
  });
});

// ---- Handler (integration — real seams, isolated tmp projectDir) ----

describe("forecastBaseAdvance", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "canon-forecast-base-advance-"));
    mockGitExec.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("happy path: direct overlap, KG absent — advisory names the file", async () => {
    mockGitExec.mockImplementation((args) => {
      if (args[0] === "rev-list") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "2\n",
          timedOut: false,
        };
      }
      if (args[0] === "diff") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "src/a.ts\nsrc/b.ts\n",
          timedOut: false,
        };
      }
      throw new Error(`unexpected gitExec args: ${args.join(" ")}`);
    });

    expect(existsSync(join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB))).toBe(false);

    const result = await forecastBaseAdvance({
      base_commit: "abc123",
      declared_files: ["src/a.ts"],
      projectDir,
      workspace: "/mock/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.commits_ahead).toBe(2);
    expect(result.overlapping_files).toEqual([{ file: "src/a.ts", reason: "direct" }]);
    expect(result.advisory).toContain("src/a.ts");
  });

  it("happy path: co-change overlap via a real KG db", async () => {
    mockGitExec.mockImplementation((args) => {
      if (args[0] === "rev-list") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "1\n",
          timedOut: false,
        };
      }
      if (args[0] === "diff") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "src/main-changed.ts\n",
          timedOut: false,
        };
      }
      throw new Error(`unexpected gitExec args: ${args.join(" ")}`);
    });

    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
    const db = initDatabase(dbPath);
    db.prepare(
      `INSERT INTO co_change_edges
       (file_a, file_b, co_commit_count, jaccard, computed_at_commit, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("src/main-changed.ts", "src/partner.ts", 5, 0.8, "abc123", new Date().toISOString());
    db.close();

    const result = await forecastBaseAdvance({
      base_commit: "abc123",
      declared_files: ["src/partner.ts"],
      projectDir,
      workspace: "/mock/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.overlapping_files).toEqual([
      {
        file: "src/partner.ts",
        jaccard: 0.8,
        partner: "src/main-changed.ts",
        reason: "co-change",
      },
    ]);
    expect(result.advisory).toContain("src/partner.ts");
  });

  it("fail-safe: gitExec rev-list failure returns a silent result, never throws", async () => {
    mockGitExec.mockImplementation(() => {
      throw new Error("git binary not found");
    });

    const result = await forecastBaseAdvance({
      base_commit: "abc123",
      declared_files: ["src/a.ts"],
      projectDir,
      workspace: "/mock/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result).toEqual({
      advisory: null,
      commits_ahead: 0,
      ok: true,
      overlapping_files: [],
    });
  });

  it("fail-safe: rev-list non-zero exit returns a silent result", async () => {
    mockGitExec.mockImplementation((args) => {
      if (args[0] === "rev-list") {
        return {
          duration_ms: 1,
          exitCode: 128,
          ok: false,
          stderr: "fatal: bad revision",
          stdout: "",
          timedOut: false,
        };
      }
      throw new Error(`unexpected gitExec args: ${args.join(" ")}`);
    });

    const result = await forecastBaseAdvance({
      base_commit: "abc123",
      declared_files: ["src/a.ts"],
      projectDir,
      workspace: "/mock/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.advisory).toBeNull();
    expect(result.commits_ahead).toBe(0);
    expect(result.overlapping_files).toEqual([]);
  });

  it("KG absent: direct-overlap path still returns a valid, non-throwing result", async () => {
    mockGitExec.mockImplementation((args) => {
      if (args[0] === "rev-list") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "1\n",
          timedOut: false,
        };
      }
      if (args[0] === "diff") {
        return {
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "src/x.ts\n",
          timedOut: false,
        };
      }
      throw new Error(`unexpected gitExec args: ${args.join(" ")}`);
    });

    expect(existsSync(join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB))).toBe(false);

    const result = await forecastBaseAdvance({
      base_commit: "abc123",
      declared_files: ["src/x.ts", "src/unrelated.ts"],
      projectDir,
      workspace: "/mock/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.overlapping_files).toEqual([{ file: "src/x.ts", reason: "direct" }]);
  });
});
