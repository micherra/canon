import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

// spawnSync mock — mutable implementation swapped per test
type SpawnSyncArgs = { shell?: boolean; cwd?: string; encoding?: string; timeout?: number };
let spawnSyncImpl: ((cmd: string, opts: SpawnSyncArgs) => { stdout: string; stderr: string; status: number; error?: Error }) | null = null;
let lastSpawnSyncArgs: { cmd: string; opts: SpawnSyncArgs } | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, opts: SpawnSyncArgs) => {
    lastSpawnSyncArgs = { cmd, opts };
    if (spawnSyncImpl) return spawnSyncImpl(cmd, opts);
    return { stdout: "", stderr: "", status: 0 };
  },
}));

// fs mock — mutable implementation swapped per test
let readFileSyncImpl: ((path: string, enc: string) => string) | null = null;

vi.mock("node:fs", () => ({
  readFileSync: (path: string, enc: string) => {
    if (readFileSyncImpl) return readFileSyncImpl(path, enc);
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { resolveGateCommand, runGate } from "../orchestration/gate-runner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(gates?: Record<string, string>): ResolvedFlow {
  return {
    name: "test-flow",
    description: "test",
    entry: "start",
    states: {},
    spawn_instructions: {},
    ...(gates ? { gates } : {}),
  };
}

beforeEach(() => {
  spawnSyncImpl = null;
  readFileSyncImpl = null;
  lastSpawnSyncArgs = null;
});

// ---------------------------------------------------------------------------
// resolveGateCommand
// ---------------------------------------------------------------------------

describe("resolveGateCommand — flow.gates map lookup", () => {
  it("returns command from flow.gates map when gate name is found", () => {
    const flow = makeFlow({ "lint": "npm run lint", "type-check": "tsc --noEmit" });
    expect(resolveGateCommand("lint", flow)).toBe("npm run lint");
    expect(resolveGateCommand("type-check", flow)).toBe("tsc --noEmit");
  });

  it("returns command for test-suite from flow.gates when explicitly mapped", () => {
    const flow = makeFlow({ "test-suite": "npx vitest run" });
    expect(resolveGateCommand("test-suite", flow)).toBe("npx vitest run");
  });
});

describe("resolveGateCommand — unknown gate with no flow.gates", () => {
  it("returns null for an unknown gate name when flow has no gates map", () => {
    const flow = makeFlow();
    expect(resolveGateCommand("arbitrary-gate-name", flow)).toBeNull();
  });

  it("returns null for an unknown gate even when flow.gates exists but does not contain it", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    expect(resolveGateCommand("unknown-gate", flow)).toBeNull();
  });

  it("returns null for a gate name that looks like a shell command (injection protection)", () => {
    const flow = makeFlow();
    // "rm -rf /" is an arbitrary string — should return null, never be executed
    expect(resolveGateCommand("rm -rf /", flow)).toBeNull();
  });
});

describe("resolveGateCommand — test-suite auto-detection from package.json", () => {
  it("returns 'npm test' when package.json has scripts.test", () => {
    readFileSyncImpl = () => JSON.stringify({ scripts: { test: "vitest run" } });
    const flow = makeFlow();
    expect(resolveGateCommand("test-suite", flow, "/some/project")).toBe("npm test");
  });

  it("falls back to 'make test' when package.json has no scripts.test", () => {
    readFileSyncImpl = () => JSON.stringify({ scripts: {} });
    const flow = makeFlow();
    expect(resolveGateCommand("test-suite", flow, "/some/project")).toBe("make test");
  });

  it("falls back to 'make test' when package.json is absent", () => {
    // readFileSyncImpl is null — mock throws ENOENT by default
    const flow = makeFlow();
    expect(resolveGateCommand("test-suite", flow, "/no/package")).toBe("make test");
  });

  it("falls back to 'make test' when package.json is not valid JSON", () => {
    readFileSyncImpl = () => "not-json{{{";
    const flow = makeFlow();
    expect(resolveGateCommand("test-suite", flow, "/bad/json")).toBe("make test");
  });
});

// ---------------------------------------------------------------------------
// runGate
// ---------------------------------------------------------------------------

describe("runGate — gate exits 0 (passed)", () => {
  it("returns passed: true when command exits with code 0", () => {
    spawnSyncImpl = () => ({ stdout: "all tests passed", stderr: "", status: 0 });
    const flow = makeFlow({ "test-suite": "npm test" });
    const result = runGate("test-suite", flow, "/project");

    expect(result.passed).toBe(true);
    expect(result.gate).toBe("test-suite");
    expect(result.command).toBe("npm test");
    expect(result.output).toContain("all tests passed");
    expect(result.exitCode).toBe(0);
  });
});

describe("runGate — gate exits non-zero (failed)", () => {
  it("returns passed: false when command exits with non-zero code", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "2 tests failed", status: 1 });
    const flow = makeFlow({ "test-suite": "npm test" });
    const result = runGate("test-suite", flow, "/project");

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("2 tests failed");
  });
});

describe("runGate — gate not configured", () => {
  it("returns passed: true with skip message when gate command is not configured", () => {
    const flow = makeFlow(); // no gates
    const result = runGate("nonexistent-gate", flow, "/project");

    expect(result.passed).toBe(true);
    expect(result.command).toBe("");
    expect(result.output).toBe("Gate not configured — skipped");
    expect(result.exitCode).toBe(0);
  });

  it("does NOT call spawnSync when gate is not configured", () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for unconfigured gate");
    };
    const flow = makeFlow();
    // Should not throw — spawnSync is not called
    expect(() => runGate("nonexistent-gate", flow, "/project")).not.toThrow();
  });
});

describe("runGate — command injection protection", () => {
  it("does NOT execute an arbitrary gateName string as a shell command", () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for arbitrary gate name");
    };
    const flow = makeFlow(); // no gates map
    // Even though spawnSyncImpl would throw if called, runGate must not call it
    const result = runGate("rm -rf /", flow, "/project");

    // Gate was not configured (null) — skipped gracefully
    expect(result.passed).toBe(true);
    expect(result.command).toBe("");
    expect(result.output).toBe("Gate not configured — skipped");
  });

  it("only executes the resolved command from flow.gates, not the gateName", () => {
    let executedCommand: string | null = null;
    spawnSyncImpl = (cmd) => {
      executedCommand = cmd;
      return { stdout: "ok", stderr: "", status: 0 };
    };
    const flow = makeFlow({ "safe-gate": "npm run lint" });
    runGate("safe-gate", flow, "/project");

    // The command that reached spawnSync is the resolved value, not "safe-gate"
    expect(executedCommand).toBe("npm run lint");
    expect(executedCommand).not.toBe("safe-gate");
  });
});

describe("runGate — spawnSync timeout configuration", () => {
  it("passes timeout option to spawnSync", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0 });
    const flow = makeFlow({ "test-suite": "npm test" });
    runGate("test-suite", flow, "/project");

    expect(lastSpawnSyncArgs).not.toBeNull();
    expect(lastSpawnSyncArgs!.opts.timeout).toBe(300_000);
  });

  it("passes shell: true to spawnSync", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0 });
    const flow = makeFlow({ "lint": "eslint ." });
    runGate("lint", flow, "/project");

    expect(lastSpawnSyncArgs!.opts.shell).toBe(true);
  });

  it("passes cwd to spawnSync", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 0 });
    const flow = makeFlow({ "check": "tsc" });
    runGate("check", flow, "/my/project");

    expect(lastSpawnSyncArgs!.opts.cwd).toBe("/my/project");
  });
});
