import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen, matchGlob } from "../orchestration/skip-when.ts";

// Hoist the mock factory so it runs before module import.
// gitExecImpl is a mutable reference we swap per test.
type GitExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};
let gitExecImpl: (() => GitExecResult) | null = null;
let lastGitExecArgs: { args: string[]; cwd: string } | null = null;

vi.mock("../platform/adapters/git-adapter.ts", () => ({
  gitExec: (args: string[], cwd: string) => {
    lastGitExecArgs = { args, cwd };
    if (gitExecImpl) return gitExecImpl();
    // Default: simulate git failure (safe default — do not skip)
    return {
      exitCode: 1,
      ok: false,
      stderr: "gitExec not configured in test",
      stdout: "",
      timedOut: false,
    };
  },
}));

function makeBoard(overrides?: Partial<Board>): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
    ...overrides,
  };
}

beforeEach(() => {
  gitExecImpl = null;
  lastGitExecArgs = null;
});

// matchGlob unit tests

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

// evaluateSkipWhen — no_fix_requested

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

// evaluateSkipWhen — auto_approved

describe("evaluateSkipWhen — auto_approved", () => {
  it("skips when board.metadata.auto_approve is true", async () => {
    const board = makeBoard({ metadata: { auto_approve: true } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("auto-approved");
  });

  it("does not skip when board.metadata.auto_approve is false", async () => {
    const board = makeBoard({ metadata: { auto_approve: false } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("does not skip when board.metadata is undefined", async () => {
    const board = makeBoard();
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("does not skip when board.metadata.auto_approve is absent", async () => {
    const board = makeBoard({ metadata: { some_other_key: "value" } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  // Truthy non-boolean values — strict === true check (declared known gap)

  it("does not skip when board.metadata.auto_approve is the string 'true' (strict equality)", async () => {
    // Implementation uses === true so non-boolean truthy values should NOT skip
    const board = makeBoard({ metadata: { auto_approve: "true" } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("does not skip when board.metadata.auto_approve is 1 (numeric truthy)", async () => {
    const board = makeBoard({ metadata: { auto_approve: 1 } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("does not skip when board.metadata.auto_approve is a non-boolean truthy value (string)", async () => {
    const board = makeBoard({ metadata: { auto_approve: "yes" } });
    const result = await evaluateSkipWhen("auto_approved", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });
});

// SkipWhenSchema — schema validation

describe("SkipWhenSchema", () => {
  it("accepts auto_approved as a valid value", async () => {
    const { SkipWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => SkipWhenSchema.parse("auto_approved")).not.toThrow();
    expect(SkipWhenSchema.parse("auto_approved")).toBe("auto_approved");
  });

  it("still accepts existing valid values", async () => {
    const { SkipWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => SkipWhenSchema.parse("no_contract_changes")).not.toThrow();
    expect(() => SkipWhenSchema.parse("no_fix_requested")).not.toThrow();
  });

  it("accepts no_open_questions as a valid value", async () => {
    const { SkipWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => SkipWhenSchema.parse("no_open_questions")).not.toThrow();
    expect(SkipWhenSchema.parse("no_open_questions")).toBe("no_open_questions");
  });

  it("rejects unknown values", async () => {
    const { SkipWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => SkipWhenSchema.parse("unknown_value")).toThrow();
  });
});

// evaluateSkipWhen — unknown condition

describe("evaluateSkipWhen — unknown condition", () => {
  it("returns skip: false and logs a console.error warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // noop
    });
    const board = makeBoard();

    const result = await evaluateSkipWhen("unknown_condition_xyz", "/tmp/ws", board);

    expect(result).toEqual({ skip: false });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown skip_when condition"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown_condition_xyz"));

    errorSpy.mockRestore();
  });
});

// evaluateSkipWhen — no_open_questions

describe("evaluateSkipWhen — no_open_questions", () => {
  it("skips when board has no metadata (has_open_questions not set)", async () => {
    const board = makeBoard();
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("No open questions");
  });

  it("skips when metadata is present but has_open_questions is not set", async () => {
    const board = makeBoard({ metadata: { some_other_key: "value" } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });

  it("skips when has_open_questions is false", async () => {
    const board = makeBoard({ metadata: { has_open_questions: false } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("targeted research skipped");
  });

  it("does not skip when has_open_questions is true", async () => {
    const board = makeBoard({ metadata: { has_open_questions: true } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("skips when has_open_questions is the string 'true' (strict === true check)", async () => {
    // Implementation uses === true so non-boolean truthy should skip (treated as falsy for our purposes)
    const board = makeBoard({ metadata: { has_open_questions: "true" } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });
});

// evaluateSkipWhen — no_contract_changes

describe("evaluateSkipWhen — no_contract_changes", () => {
  it("returns skip: true when only non-contract files changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/some-internal.ts\nsrc/utils/helper.ts\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("No contract changes detected");
  });

  it("returns skip: false when API files changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/api/users.ts\nsrc/internal/helper.ts\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: false when index.ts changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/index.ts\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: false when package.json changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "package.json\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("returns skip: true when contract files are only deleted (not added/modified)", async () => {
    // --diff-filter=d excludes deleted files, so git returns only the non-contract file
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/utils/helper.ts\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("No contract changes detected");
  });

  it("passes --diff-filter=d to gitExec to exclude deleted files from contract check", async () => {
    gitExecImpl = () => ({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false });
    const board = makeBoard({ base_commit: "abc1234" });
    await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(lastGitExecArgs?.args).toContain("--diff-filter=d");
  });

  it("returns skip: true when diff output is empty (no changes at all)", async () => {
    gitExecImpl = () => ({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
  });

  it("returns skip: false when gitExec returns ok: false (non-zero exit)", async () => {
    gitExecImpl = () => ({
      exitCode: 128,
      ok: false,
      stderr: "fatal: not a repository",
      stdout: "",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Fail-open for skip = fail-closed for execution
    expect(result.skip).toBe(false);
  });

  it("returns skip: false when gitExec returns ok: false (timeout)", async () => {
    // Risk 9: adapter returns timedOut: true → function degrades gracefully
    gitExecImpl = () => ({ exitCode: 1, ok: false, stderr: "", stdout: "", timedOut: true });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Timed out — fail-open for skip, fail-closed for execution
    expect(result.skip).toBe(false);
  });

  // Security: input validation — malicious base_commit strings

  it("rejects base_commit with shell metacharacters (command injection attempt)", async () => {
    // gitExecImpl should never be called — validation rejects before reaching adapter
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc123; rm -rf /" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit with backtick injection", async () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "`whoami`" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit with newline injection", async () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc123\nrm -rf /" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects empty base_commit string", async () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("rejects base_commit that is too short (fewer than 7 hex chars)", async () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for malicious input");
    };
    const board = makeBoard({ base_commit: "abc12" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(false);
  });

  it("accepts a valid 7-char short SHA", async () => {
    gitExecImpl = () => ({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    // Empty diff → no contract changes → skip
    expect(result.skip).toBe(true);
  });

  it("accepts a valid 40-char full SHA", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/internal.ts\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);

    expect(result.skip).toBe(true);
  });
});
