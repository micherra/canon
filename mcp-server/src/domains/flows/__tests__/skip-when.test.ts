import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../board-state-schemas.ts";
import { evaluateSkipWhen, matchGlob } from "../skip-when.ts";

// Mock getProjectDir from wave-lifecycle.ts
vi.mock(
  "@domains/workspaces/wave-lifecycle.ts",
  () => ({
    getProjectDir: vi.fn().mockReturnValue("/project"),
  }),
);

// Mock platform drift-db for learn gate tests
vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({ countFlowRunsSince: vi.fn().mockReturnValue(10) }),
}));

// Mock shared learn-lock for learn gate tests
vi.mock("@shared/lib/learn-lock.ts", () => ({
  acquireLearnLock: vi.fn().mockResolvedValue({ acquired: true, previousMtime: null }),
  getLastLearnTimestamp: vi.fn().mockResolvedValue(null),
}));

// Mock shared config for learn gate tests
vi.mock("@shared/lib/config.ts", () => ({
  loadLearnGateConfig: vi.fn().mockResolvedValue({
    enabled: true,
    lock_stale_after_hours: 1,
    min_flows_since_last: 5,
    min_hours_since_last: 48,
  }),
}));

// Mock node:fs/promises stat and writeFile for throttle gate
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock("@platform/adapters/git-adapter.ts", () => ({
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
    const { SkipWhenSchema } = await import("../flow-definition-schemas.ts");
    expect(() => SkipWhenSchema.parse("auto_approved")).not.toThrow();
    expect(SkipWhenSchema.parse("auto_approved")).toBe("auto_approved");
  });

  it("still accepts existing valid values", async () => {
    const { SkipWhenSchema } = await import("../flow-definition-schemas.ts");
    expect(() => SkipWhenSchema.parse("no_contract_changes")).not.toThrow();
    expect(() => SkipWhenSchema.parse("no_fix_requested")).not.toThrow();
  });

  it("accepts no_open_questions as a valid value", async () => {
    const { SkipWhenSchema } = await import("../flow-definition-schemas.ts");
    expect(() => SkipWhenSchema.parse("no_open_questions")).not.toThrow();
    expect(SkipWhenSchema.parse("no_open_questions")).toBe("no_open_questions");
  });

  it("rejects unknown values", async () => {
    const { SkipWhenSchema } = await import("../flow-definition-schemas.ts");
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

// evaluateSkipWhen — learn_gate_not_passed

describe("evaluateSkipWhen — learn_gate_not_passed", () => {
  let loadLearnGateConfig: ReturnType<typeof vi.fn>;
  let getLastLearnTimestamp: ReturnType<typeof vi.fn>;
  let acquireLearnLock: ReturnType<typeof vi.fn>;
  let getDriftDb: ReturnType<typeof vi.fn>;
  let statMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const configMod = await import("@shared/lib/config.ts");
    loadLearnGateConfig = vi.mocked(configMod.loadLearnGateConfig);
    loadLearnGateConfig.mockResolvedValue({
      enabled: true,
      lock_stale_after_hours: 1,
      min_flows_since_last: 5,
      min_hours_since_last: 48,
    });

    const lockMod = await import("@shared/lib/learn-lock.ts");
    getLastLearnTimestamp = vi.mocked(lockMod.getLastLearnTimestamp);
    acquireLearnLock = vi.mocked(lockMod.acquireLearnLock);
    getLastLearnTimestamp.mockResolvedValue(null); // no prior learn
    acquireLearnLock.mockResolvedValue({ acquired: true, previousMtime: null });

    const driftMod = await import("@platform/storage/drift/drift-db.ts");
    getDriftDb = vi.mocked(driftMod.getDriftDb);
    getDriftDb.mockReturnValue({ countFlowRunsSince: vi.fn().mockReturnValue(10) });

    const fsMod = await import("node:fs/promises");
    statMock = vi.mocked(fsMod.stat as ReturnType<typeof vi.fn>);
    statMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  });

  it("returns skip: false when all 5 gates pass", async () => {
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("returns skip: true when auto-learn disabled in config (gate 1)", async () => {
    loadLearnGateConfig.mockResolvedValue({
      enabled: false,
      lock_stale_after_hours: 1,
      min_flows_since_last: 5,
      min_hours_since_last: 48,
    });
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("auto-learn disabled");
  });

  it("returns skip: true when time gate fails (gate 2)", async () => {
    // last learn was 1 hour ago, min is 48h
    getLastLearnTimestamp.mockResolvedValue(Date.now() - 1 * 60 * 60 * 1000);
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("time gate");
  });

  it("returns skip: true when flow gate fails (gate 4)", async () => {
    getDriftDb.mockReturnValue({ countFlowRunsSince: vi.fn().mockReturnValue(2) }); // < 5
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("flow gate");
  });

  it("returns skip: true when lock gate fails (gate 5)", async () => {
    acquireLearnLock.mockResolvedValue({ acquired: false, reason: "already_locked" });
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("lock gate");
  });

  it("returns skip: true with reason when config loading throws (fail-open)", async () => {
    loadLearnGateConfig.mockRejectedValue(new Error("unexpected config error"));
    const board = makeBoard();
    const result = await evaluateSkipWhen("learn_gate_not_passed", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("Learn gate evaluation failed");
  });

  it("unknown skip_when condition still returns skip: false (existing behavior preserved)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // noop
    });
    const board = makeBoard();
    const result = await evaluateSkipWhen("totally_unknown_condition", "/tmp/ws", board);
    expect(result.skip).toBe(false);
    errorSpy.mockRestore();
  });
});

// matchGlob — new structure patterns

describe("matchGlob — structure patterns", () => {
  it("matches README.md at root", () => {
    expect(matchGlob("README.md", "README.md")).toBe(true);
  });

  it("matches README.md in subdirectories", () => {
    expect(matchGlob("**/README.md", "src/README.md")).toBe(true);
    expect(matchGlob("**/README.md", "packages/core/README.md")).toBe(true);
    expect(matchGlob("**/README.md", "deep/nested/dir/README.md")).toBe(true);
  });

  it("does not match non-README files with README pattern", () => {
    expect(matchGlob("README.md", "READMENOT.md")).toBe(false);
    expect(matchGlob("**/README.md", "src/notes.md")).toBe(false);
  });

  it("matches Dockerfile at root", () => {
    expect(matchGlob("Dockerfile", "Dockerfile")).toBe(true);
  });

  it("matches Dockerfile in subdirectories", () => {
    expect(matchGlob("**/Dockerfile", "services/api/Dockerfile")).toBe(true);
    expect(matchGlob("**/Dockerfile", "docker/Dockerfile")).toBe(true);
  });

  it("matches docker-compose files with wildcard suffix", () => {
    expect(matchGlob("docker-compose*", "docker-compose.yml")).toBe(true);
    expect(matchGlob("docker-compose*", "docker-compose.override.yml")).toBe(true);
    expect(matchGlob("docker-compose*", "docker-compose.prod.yml")).toBe(true);
  });

  it("does not match unrelated files with docker-compose pattern", () => {
    expect(matchGlob("docker-compose*", "Dockerfile")).toBe(false);
    expect(matchGlob("docker-compose*", "src/docker-config.ts")).toBe(false);
  });

  it("matches Makefile at root", () => {
    expect(matchGlob("Makefile", "Makefile")).toBe(true);
  });

  it("does not match non-Makefile files", () => {
    expect(matchGlob("Makefile", "makefile")).toBe(false);
    expect(matchGlob("Makefile", "GNUmakefile")).toBe(false);
  });

  it("matches files in bin directories (with path prefix)", () => {
    expect(matchGlob("**/bin/**", "scripts/bin/deploy.sh")).toBe(true);
    expect(matchGlob("**/bin/**", "src/bin/cli.ts")).toBe(true);
    expect(matchGlob("**/bin/**", "packages/app/bin/start")).toBe(true);
  });

  it("does not match files outside bin directories", () => {
    expect(matchGlob("**/bin/**", "src/binary-utils.ts")).toBe(false);
    expect(matchGlob("**/bin/**", "bin-tools/runner.ts")).toBe(false);
  });
});

// evaluateSkipWhen — no_contract_changes with structure patterns

describe("evaluateSkipWhen — no_contract_changes with structure patterns", () => {
  it("returns skip: false when README.md changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "README.md\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("returns skip: false when Dockerfile changed", async () => {
    gitExecImpl = () => ({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "Dockerfile\n",
      timedOut: false,
    });
    const board = makeBoard({ base_commit: "abc1234" });
    const result = await evaluateSkipWhen("no_contract_changes", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });
});

// SkipWhenSchema — learn_gate_not_passed value

describe("SkipWhenSchema — learn_gate_not_passed", () => {
  it("accepts learn_gate_not_passed as a valid value", async () => {
    const { SkipWhenSchema } = await import("../flow-definition-schemas.ts");
    expect(() => SkipWhenSchema.parse("learn_gate_not_passed")).not.toThrow();
    expect(SkipWhenSchema.parse("learn_gate_not_passed")).toBe("learn_gate_not_passed");
  });
});
