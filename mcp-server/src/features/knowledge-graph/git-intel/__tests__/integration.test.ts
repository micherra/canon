/**
 * integration.test.ts
 *
 * Integration tests for git-intel integration with get_file_context and show_pr_impact.
 *
 * Tests cover:
 * - loadKgData returns hotspot_score when git intel data is available
 * - loadKgData returns co_change_partners for both edge directions
 * - loadKgData omits hotspot_score and co_change_partners when no git intel data
 * - computeKgData returns co_change_warnings when partner not in changed set
 * - computeKgData returns empty co_change_warnings when all partners present
 * - computeKgData returns empty co_change_warnings when no co-change data
 * - getPrReviewData hotspot_files populated from git intel
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDatabase } from "@graph/kg-schema.ts";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi.fn(),
  gitDiff: vi.fn(),
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitWorktreeAdd: vi.fn(),
}));

vi.mock("@platform/adapters/git-adapter-async.ts", () => ({
  gitExecAsync: vi.fn().mockResolvedValue({
    duration_ms: 0,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
  }),
}));

vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn().mockReturnValue({
    duration_ms: 0,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
  }),
}));

// Import mocked adapter after vi.mock declarations
import { gitExec } from "@platform/adapters/git-adapter.ts";

// Import test targets
import { loadKgData } from "../../../file-context/tools/get-file-context.ts";
import { computeKgData } from "../../../pr-review/tools/show-pr-impact.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAD_SHA = "abc123def456abc123def456abc123def456abc1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir with a minimal .canon/ structure. */
function makeTempProjectDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-intel-integration-"));
  fs.mkdirSync(path.join(tmp, ".canon"), { recursive: true });
  return tmp;
}

/** Seed hotspot and co-change data into a DB. */
function seedGitIntelData(dbPath: string): void {
  const db = initDatabase(dbPath);
  db.exec(`
    INSERT OR REPLACE INTO hotspot_scores (
      file_path, churn_raw, churn_percentile, complexity_raw,
      complexity_pctile, score, is_hotspot, computed_at_commit, computed_at
    ) VALUES
      ('src/alpha.ts', 10.0, 0.9, 5.0, 0.85, 0.88, 1, '${HEAD_SHA}', '2026-01-01T00:00:00Z'),
      ('src/beta.ts', 3.0, 0.4, 2.0, 0.3, 0.35, 0, '${HEAD_SHA}', '2026-01-01T00:00:00Z');

    INSERT OR REPLACE INTO co_change_edges (
      file_a, file_b, co_commit_count, jaccard, computed_at_commit, computed_at
    ) VALUES
      ('src/alpha.ts', 'src/gamma.ts', 5, 0.8, '${HEAD_SHA}', '2026-01-01T00:00:00Z'),
      ('src/delta.ts', 'src/alpha.ts', 3, 0.6, '${HEAD_SHA}', '2026-01-01T00:00:00Z');
  `);
  db.close();
}

// ---------------------------------------------------------------------------
// Tests: loadKgData git-intel integration
// ---------------------------------------------------------------------------

describe("loadKgData — git-intel integration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTempProjectDir();
    dbPath = path.join(tmpDir, ".canon", "knowledge-graph.db");

    // Create and seed the database
    const db = initDatabase(dbPath);
    db.close();
    seedGitIntelData(dbPath);

    // git HEAD returns our fixed SHA — data is already fresh
    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: HEAD_SHA,
      timedOut: false,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("returns hotspot_score when git intel data is available", () => {
    const result = loadKgData(dbPath, "src/alpha.ts", tmpDir);
    expect(result.hotspot_score).toBeDefined();
    expect(result.hotspot_score?.is_hotspot).toBe(true);
    expect(result.hotspot_score?.churn_percentile).toBeCloseTo(0.9);
    expect(result.hotspot_score?.complexity_percentile).toBeCloseTo(0.85);
    expect(result.hotspot_score?.score).toBeCloseTo(0.88);
  });

  test("returns co_change_partners querying both edge directions", () => {
    const result = loadKgData(dbPath, "src/alpha.ts", tmpDir);
    expect(result.co_change_partners).toBeDefined();
    // alpha appears as file_a (→ gamma) and file_b (← delta)
    expect(result.co_change_partners?.length).toBe(2);
    const paths = result.co_change_partners!.map((p) => p.path);
    expect(paths).toContain("src/gamma.ts");
    expect(paths).toContain("src/delta.ts");
    // sorted by jaccard descending (gamma=0.8 > delta=0.6)
    expect(result.co_change_partners![0].jaccard).toBeGreaterThanOrEqual(
      result.co_change_partners![1].jaccard,
    );
  });

  test("omits hotspot_score and co_change_partners when projectDir not provided", () => {
    // First call (no projectDir) — should NOT trigger git intel
    const result = loadKgData(dbPath, "src/alpha.ts");
    expect(result.hotspot_score).toBeUndefined();
    expect(result.co_change_partners).toBeUndefined();
  });

  test("omits hotspot_score and co_change_partners when no git intel data (git unavailable)", () => {
    // Fresh DB with no hotspot data; git unavailable so pipeline won't run
    const emptyDbPath = path.join(tmpDir, ".canon", "empty.db");
    const emptyDb = initDatabase(emptyDbPath);
    emptyDb.close();

    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 128,
      ok: false,
      stderr: "not a git repo",
      stdout: "",
      timedOut: false,
    });

    const result = loadKgData(emptyDbPath, "src/alpha.ts", tmpDir);
    expect(result.hotspot_score).toBeUndefined();
    expect(result.co_change_partners).toBeUndefined();
  });

  test("returns non-hotspot score for non-hotspot file", () => {
    const result = loadKgData(dbPath, "src/beta.ts", tmpDir);
    expect(result.hotspot_score).toBeDefined();
    expect(result.hotspot_score?.is_hotspot).toBe(false);
    expect(result.hotspot_score?.churn_percentile).toBeCloseTo(0.4);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeKgData co-change warnings
// ---------------------------------------------------------------------------

describe("computeKgData — co_change_warnings", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTempProjectDir();
    dbPath = path.join(tmpDir, ".canon", "knowledge-graph.db");

    const db = initDatabase(dbPath);
    db.close();
    seedGitIntelData(dbPath);

    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: HEAD_SHA,
      timedOut: false,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("returns co_change_warnings for files missing partners in the diff", () => {
    // Only alpha.ts changed — gamma.ts and delta.ts are missing partners
    const result = computeKgData(dbPath, ["src/alpha.ts"], [], tmpDir);
    expect(result.co_change_warnings).toBeDefined();
    expect(result.co_change_warnings.length).toBeGreaterThan(0);
    const missingPartners = result.co_change_warnings.map((w) => w.missing_partner);
    expect(missingPartners).toContain("src/gamma.ts");
    expect(missingPartners).toContain("src/delta.ts");
    // warnings reference the correct source file
    for (const w of result.co_change_warnings) {
      expect(w.file).toBe("src/alpha.ts");
      expect(w.jaccard).toBeGreaterThan(0);
    }
  });

  test("returns empty co_change_warnings when all co-change partners are present", () => {
    const changedFiles = ["src/alpha.ts", "src/gamma.ts", "src/delta.ts"];
    const result = computeKgData(dbPath, changedFiles, [], tmpDir);
    expect(result.co_change_warnings).toBeDefined();
    expect(result.co_change_warnings.length).toBe(0);
  });

  test("returns empty co_change_warnings when no co-change data exists", () => {
    // Empty DB — no hotspot or co-change data; git unavailable so pipeline skipped
    const emptyDbPath = path.join(tmpDir, ".canon", "empty.db");
    const emptyDb = initDatabase(emptyDbPath);
    emptyDb.close();

    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 128,
      ok: false,
      stderr: "",
      stdout: "",
      timedOut: false,
    });

    const result = computeKgData(emptyDbPath, ["src/alpha.ts"], [], tmpDir);
    expect(result.co_change_warnings).toBeDefined();
    expect(result.co_change_warnings.length).toBe(0);
  });

  test("warnings are sorted by jaccard descending and limited to 10", () => {
    // Seed many co-change edges for alpha
    const db = initDatabase(dbPath);
    for (let i = 0; i < 15; i++) {
      const jac = (15 - i) / 20; // decreasing jaccard values
      db.exec(`
        INSERT OR REPLACE INTO co_change_edges (
          file_a, file_b, co_commit_count, jaccard, computed_at_commit, computed_at
        ) VALUES ('src/alpha.ts', 'src/file${i}.ts', ${i + 1}, ${jac}, '${HEAD_SHA}', '2026-01-01T00:00:00Z');
      `);
    }
    db.close();

    const result = computeKgData(dbPath, ["src/alpha.ts"], [], tmpDir);
    // Should be limited to 10 and sorted descending
    expect(result.co_change_warnings.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < result.co_change_warnings.length; i++) {
      expect(result.co_change_warnings[i - 1].jaccard).toBeGreaterThanOrEqual(
        result.co_change_warnings[i].jaccard,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: getPrReviewData hotspot_files — via loadKgData indirection
// ---------------------------------------------------------------------------

describe("hotspot_files detection via git-intel", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTempProjectDir();
    dbPath = path.join(tmpDir, ".canon", "knowledge-graph.db");

    const db = initDatabase(dbPath);
    db.close();
    seedGitIntelData(dbPath);

    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: HEAD_SHA,
      timedOut: false,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("hotspot_score is_hotspot=true for alpha.ts (seeded as hotspot)", () => {
    // alpha.ts was seeded with is_hotspot=1; verify loadKgData sees it
    const result = loadKgData(dbPath, "src/alpha.ts", tmpDir);
    expect(result.hotspot_score?.is_hotspot).toBe(true);
  });

  test("hotspot_score is_hotspot=false for beta.ts (seeded as non-hotspot)", () => {
    const result = loadKgData(dbPath, "src/beta.ts", tmpDir);
    expect(result.hotspot_score?.is_hotspot).toBe(false);
  });

  test("no hotspot_score for file not in hotspot_scores table", () => {
    const result = loadKgData(dbPath, "src/unknown.ts", tmpDir);
    expect(result.hotspot_score).toBeUndefined();
  });
});
