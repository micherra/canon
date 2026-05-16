import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../board-state-schemas.ts";
import { evaluateSkipWhen, matchGlob } from "../skip-when.ts";

// Mock getProjectDir from worktree-ops.ts
vi.mock("@domains/workspaces/worktree-ops.ts", () => ({
  getProjectDir: vi.fn().mockReturnValue("/project"),
}));

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

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: (args: string[], cwd: string) => {
    void args;
    void cwd;
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
