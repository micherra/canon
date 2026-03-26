import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Board } from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen, matchGlob } from "../orchestration/skip-when.ts";

// Hoist the mock factory so it runs before module import.
// spawnSyncImpl is a mutable reference we swap per test.
type SpawnSyncResult = { stdout: string; status: number; error?: Error };
let spawnSyncImpl: (() => SpawnSyncResult) | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => {
    if (spawnSyncImpl) return spawnSyncImpl();
    // Default: simulate git failure (safe default — do not skip)
    return { stdout: "", status: 1, error: new Error("spawnSync not configured in test") };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(overrides?: Partial<Board>): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  };
}

beforeEach(() => {
  spawnSyncImpl = null;
});

// ---------------------------------------------------------------------------
// matchGlob unit tests
// ---------------------------------------------------------------------------

describe("matchGlob", () => {
  it("matches exact file names", () => {
    expect(matchGlob("package.json", "package.json")).toBe(true);
    expect(matchGlob("package.json", "other.json")).toBe(false);
  });

  it("matches ** glob at any path depth", () => {
    expect(matchGlob("**/index.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("**/index.ts", "src/deep/nested/index.ts")).toBe(true);
    expect(matchGlob("**/index.ts", "src/other.ts")).toBe(false);
  });

  it("matches ** directory prefix patterns", () => {
    expect(matchGlob("**/api/**", "src/api/users.ts")).toBe(true);
    expect(matchGlob("**/api/**", "src/api/v2/users.ts")).toBe(true);
    expect(matchGlob("**/routes/**", "src/routes/auth.ts")).toBe(true);
    expect(matchGlob("**/routes/**", "src/handlers/auth.ts")).toBe(false);
  });

  it("matches schema files with wildcard suffix", () => {
    expect(matchGlob("**/schema*", "src/schema.ts")).toBe(true);
    expect(matchGlob("**/schema*", "src/schema-utils.ts")).toBe(true);
  });

  it("matches types directory files", () => {
    expect(matchGlob("**/types/**", "src/types/user.ts")).toBe(true);
    expect(matchGlob("**/types/**", "src/utils/user.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateSkipWhen — no_fix_requested
// ---------------------------------------------------------------------------

describe("evaluateSkipWhen — no_fix_requested", () => {
  it("skips when board has no metadata", async () => {
    const board = makeBoard();
    const result = await evaluateSkipWhen("no_fix_requested", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });

  it("skips when fix_requested is not set in metadata", async () => {
    const board = makeBoard({ metadata: { some_other_key: "value" } });
    const result = await evaluateSkipWhen("no_fix_requested", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });

  it("does not skip when fix_requested is true", async () => {
    const board = makeBoard({ metadata: { fix_requested: true } });
    const result = await evaluateSkipWhen("no_fix_requested", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("skips when fix_requested is false", async () => {
    const board = makeBoard({ metadata: { fix_requested: false } });
    const result = await evaluateSkipWhen("no_fix_requested", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateSkipWhen — unknown condition
// ---------------------------------------------------------------------------

describe("evaluateSkipWhen — unknown condition", () => {
  it("returns skip: false and logs a console.error warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const board = makeBoard();

    const result = await evaluateSkipWhen("unknown_condition_xyz", "/tmp/ws", board);

    expect(result).toEqual({ skip: false });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown skip_when condition"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown_condition_xyz"),
    );

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// evaluateSkipWhen — no_contract_changes
// ---------------------------------------------------------------------------

describe("evaluateSkipWhen — no_contract_changes", () => {
  it("returns skip: true when only non-contract files changed", async () => {
    spawnSyncImpl = () => ({ stdout: "src/some-internal.ts\nsrc/utils/helper.ts\n", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("No contract changes detected");
  });

  it("returns skip: false when API files changed", async () => {
    spawnSyncImpl = () => ({ stdout: "src/api/users.ts\nsrc/internal/helper.ts\n", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: false when index.ts changed", async () => {
    spawnSyncImpl = () => ({ stdout: "src/index.ts\n", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: false when package.json changed", async () => {
    spawnSyncImpl = () => ({ stdout: "package.json\n", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: true when diff output is empty (no changes at all)", async () => {
    spawnSyncImpl = () => ({ stdout: "", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
  });

  it("returns skip: false when git diff returns non-zero exit code", async () => {
    spawnSyncImpl = () => ({ stdout: "", status: 128 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Fail-open for skip = fail-closed for execution
    expect(result.skip).toBe(false);
  });

  it("returns skip: false when spawnSync returns an error — fail-open means agent still runs", async () => {
    spawnSyncImpl = () => ({
      stdout: "",
      status: -1,
      error: new Error("fatal: not a git repository"),
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Fail-open for skip = fail-closed for execution
    expect(result.skip).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Security: input validation — malicious base_commit strings
  // -------------------------------------------------------------------------

  it("rejects base_commit with shell metacharacters (command injection attempt)", async () => {
    // spawnSyncImpl should never be called — validation rejects before reaching spawn
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc123; rm -rf /" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit with backtick injection", async () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "`whoami`" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit with newline injection", async () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc123\nrm -rf /" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects empty base_commit string", async () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit that is too short (fewer than 7 hex chars)", async () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc12" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("accepts a valid 7-char short SHA", async () => {
    spawnSyncImpl = () => ({ stdout: "", status: 0 });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Empty diff → no contract changes → skip
    expect(result.skip).toBe(true);
  });

  it("accepts a valid 40-char full SHA", async () => {
    spawnSyncImpl = () => ({ stdout: "src/internal.ts\n", status: 0 });
    const board = makeBoard({ base_commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
  });

});
