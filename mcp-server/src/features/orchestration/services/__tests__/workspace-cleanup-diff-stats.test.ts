/**
 * workspace-cleanup — diff stats unit tests (TDD: written before production code).
 *
 * Tests cover:
 *  parseShortstat:
 *    1. Full line  → { diff_stat, total_files_changed }
 *    2. Singular "1 file changed" → total_files_changed: 1
 *    3. Insertions-only line parses correctly
 *    4. Deletions-only line parses correctly
 *    5. Empty string "" → { total_files_changed: 0 } (measured zero)
 *    6. Whitespace-only "\n" → { total_files_changed: 0 }
 *    7. Garbage text → {} (fields absent)
 *
 *  tryComputeDiffStats:
 *    8. Happy path: board + session + git ok → both fields returned
 *    9. No board (board === null) → {} and gitDiffFn not called
 *   10. board present but base_commit empty/falsy → {} and gitDiffFn not called
 *   11. Worktree path does not exist → {} and gitDiffFn not called
 *   12. gitDiffFn returns ok: false → {} (and console.warn called)
 *   13. getExecutionStore throws → {} (never propagates)
 *
 *  tryAppendAnalytics (seam AC1 + AC2):
 *   14. Diff data available → appendFlowRun entry contains diff_stat + total_files_changed
 *   15. Git fails → appendFlowRun entry does NOT contain diff_stat key, still returns true
 *
 * Mock strategy:
 *  - vi.mock for @domains/workspaces/execution-store-cache.ts
 *  - vi.mock for @platform/storage/drift/analytics.ts
 *  - vi.mock for node:fs (existsSync only)
 *  - Inject gitDiffFn directly — no real git needed
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DiffStatFields } from "../workspace-cleanup.ts";

// ---- Module mocks (must appear before value imports) ----

const mockGetBoard = vi.fn();
const mockGetSession = vi.fn();

// Hoisted factory — lets individual tests override getExecutionStore behavior
let executionStoreFactory: (_workspace: string) => {
  getBoard: () => unknown;
  getSession: () => unknown;
} = (_workspace) => ({
  getBoard: () => mockGetBoard(),
  getSession: () => mockGetSession(),
});

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: (_workspace: string) => executionStoreFactory(_workspace),
}));

const mockAppendFlowRun = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/storage/drift/analytics.ts", () => ({
  appendFlowRun: (projectDir: string, entry: unknown) => mockAppendFlowRun(projectDir, entry),
}));

// Mock computeFlowOutcome from orchestration-journal to avoid deep dependency
vi.mock("../../../tools/orchestration-journal.ts", () => ({
  computeFlowOutcome: vi.fn().mockReturnValue({ total_duration_ms: 1000 }),
}));

// Mock existsSync from node:fs
const mockExistsSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: (path: string) => mockExistsSync(path),
  };
});

// Import after mocks
import { parseShortstat, tryAppendAnalytics, tryComputeDiffStats } from "../workspace-cleanup.ts";

// ---- Helpers ----

type MockProcessResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string };

function makeGitOk(stdout: string): MockProcessResult {
  return { ok: true, stdout, stderr: "" };
}

function makeGitFail(stderr = "fatal: bad revision"): MockProcessResult {
  return { ok: false, stdout: "", stderr };
}

const WORKSPACE = "/fake/workspace";
const WORKTREE = "/fake/workspace/worktree";
const BASE_COMMIT = "abc123def456";

// Noop for console.warn suppression (satisfies noEmptyBlockStatements)
function noop(): void {
  // intentionally empty — silences console.warn in tests that assert on it
}

// ---- parseShortstat ----

describe("parseShortstat", () => {
  test("full line returns diff_stat and total_files_changed", () => {
    const result = parseShortstat("12 files changed, 340 insertions(+), 25 deletions(-)");
    expect(result).toEqual<DiffStatFields>({
      diff_stat: "12 files changed, 340 insertions(+), 25 deletions(-)",
      total_files_changed: 12,
    });
  });

  test("singular '1 file changed' returns total_files_changed: 1", () => {
    const result = parseShortstat("1 file changed, 2 insertions(+)");
    expect(result.total_files_changed).toBe(1);
    expect(result.diff_stat).toBe("1 file changed, 2 insertions(+)");
  });

  test("insertions-only line parses correctly", () => {
    const result = parseShortstat("3 files changed, 50 insertions(+)");
    expect(result.total_files_changed).toBe(3);
    expect(result.diff_stat).toBe("3 files changed, 50 insertions(+)");
  });

  test("deletions-only line parses correctly", () => {
    const result = parseShortstat("2 files changed, 10 deletions(-)");
    expect(result.total_files_changed).toBe(2);
    expect(result.diff_stat).toBe("2 files changed, 10 deletions(-)");
  });

  test("empty string returns { total_files_changed: 0 } (measured zero, no diff_stat)", () => {
    const result = parseShortstat("");
    expect(result).toEqual<DiffStatFields>({ total_files_changed: 0 });
    expect("diff_stat" in result).toBe(false);
  });

  test("whitespace-only string (\\n) returns { total_files_changed: 0 }", () => {
    const result = parseShortstat("\n");
    expect(result).toEqual<DiffStatFields>({ total_files_changed: 0 });
    expect("diff_stat" in result).toBe(false);
  });

  test("garbage text returns {} (fields absent)", () => {
    const result = parseShortstat("not a shortstat line at all");
    expect(result).toEqual<DiffStatFields>({});
    expect("diff_stat" in result).toBe(false);
    expect("total_files_changed" in result).toBe(false);
  });
});

// ---- tryComputeDiffStats ----

describe("tryComputeDiffStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBoard.mockReturnValue({ base_commit: BASE_COMMIT });
    mockGetSession.mockReturnValue({ worktree_path: WORKTREE });
    mockExistsSync.mockReturnValue(true);
    // Reset factory to default after any test that overrides it
    executionStoreFactory = (_workspace) => ({
      getBoard: () => mockGetBoard(),
      getSession: () => mockGetSession(),
    });
  });

  test("happy path: returns both fields when board, session, and git all succeed", () => {
    const gitDiffFn = vi
      .fn()
      .mockReturnValue(makeGitOk("5 files changed, 100 insertions(+), 20 deletions(-)"));
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result.total_files_changed).toBe(5);
    expect(result.diff_stat).toBe("5 files changed, 100 insertions(+), 20 deletions(-)");
    expect(gitDiffFn).toHaveBeenCalledWith(["--shortstat", `${BASE_COMMIT}..HEAD`], WORKTREE);
  });

  test("no board (null) returns {} and gitDiffFn not called", () => {
    mockGetBoard.mockReturnValue(null);
    const gitDiffFn = vi.fn();
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result).toEqual({});
    expect(gitDiffFn).not.toHaveBeenCalled();
  });

  test("board present but base_commit empty returns {} and gitDiffFn not called", () => {
    mockGetBoard.mockReturnValue({ base_commit: "" });
    const gitDiffFn = vi.fn();
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result).toEqual({});
    expect(gitDiffFn).not.toHaveBeenCalled();
  });

  test("worktree path does not exist returns {} and gitDiffFn not called", () => {
    mockExistsSync.mockReturnValue(false);
    const gitDiffFn = vi.fn();
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result).toEqual({});
    expect(gitDiffFn).not.toHaveBeenCalled();
  });

  test("gitDiffFn returns ok: false → returns {} and console.warn is called", () => {
    const gitDiffFn = vi.fn().mockReturnValue(makeGitFail());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[canon] finalizeWorkspace: diff shortstat failed:"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  test("getExecutionStore throws → returns {} and never propagates", () => {
    // Override factory to simulate a store that throws on construction
    executionStoreFactory = (_workspace) => {
      throw new Error("DB connection failed");
    };
    const gitDiffFn = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    let result: DiffStatFields | undefined;
    expect(() => {
      result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    }).not.toThrow();
    expect(result).toEqual({});
    expect(gitDiffFn).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("empty diff (empty stdout) returns { total_files_changed: 0 }, diff_stat absent", () => {
    const gitDiffFn = vi.fn().mockReturnValue(makeGitOk(""));
    const result = tryComputeDiffStats(WORKSPACE, gitDiffFn);
    expect(result.total_files_changed).toBe(0);
    expect("diff_stat" in result).toBe(false);
  });
});

// ---- tryAppendAnalytics (seam tests) ----

describe("tryAppendAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFlowRun.mockResolvedValue(undefined);
    mockGetBoard.mockReturnValue({ base_commit: BASE_COMMIT });
    mockGetSession.mockReturnValue({ worktree_path: WORKTREE, slug: "my-flow" });
    mockExistsSync.mockReturnValue(true);
    executionStoreFactory = (_workspace) => ({
      getBoard: () => mockGetBoard(),
      getSession: () => mockGetSession(),
    });
  });

  test("diff data available → appendFlowRun entry contains diff_stat and total_files_changed", async () => {
    const gitDiffFn = vi
      .fn()
      .mockReturnValue(makeGitOk("7 files changed, 200 insertions(+), 15 deletions(-)"));
    const result = await tryAppendAnalytics(WORKSPACE, [], "/project", gitDiffFn);
    expect(result).toBe(true);
    expect(mockAppendFlowRun).toHaveBeenCalledOnce();
    const [, entry] = mockAppendFlowRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(entry.total_files_changed).toBe(7);
    expect(entry.diff_stat).toBe("7 files changed, 200 insertions(+), 15 deletions(-)");
  });

  test("git fails → appendFlowRun entry does NOT contain diff_stat, still returns true", async () => {
    const gitDiffFn = vi.fn().mockReturnValue(makeGitFail());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    const result = await tryAppendAnalytics(WORKSPACE, [], "/project", gitDiffFn);
    expect(result).toBe(true);
    expect(mockAppendFlowRun).toHaveBeenCalledOnce();
    const [, entry] = mockAppendFlowRun.mock.calls[0] as [string, Record<string, unknown>];
    expect("diff_stat" in entry).toBe(false);
    expect("total_files_changed" in entry).toBe(false);
    warnSpy.mockRestore();
  });
});
