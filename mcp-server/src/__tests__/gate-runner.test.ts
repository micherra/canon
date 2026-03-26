import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedFlow, BoardStateEntry } from "../orchestration/flow-schema.ts";

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

import { resolveGateCommand, runGate, normalizeGates, runGates } from "../orchestration/gate-runner.ts";

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

function makeStateDef(overrides: Partial<{ gate: string; gates: string[] }> = {}): Parameters<typeof normalizeGates>[0] {
  return {
    type: "single",
    ...overrides,
  };
}

function makeBoardState(discovered_gates?: Array<{ command: string; source: string }>): BoardStateEntry {
  return {
    status: "in_progress",
    entries: 0,
    ...(discovered_gates !== undefined ? { discovered_gates } : {}),
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
// runGate — fail-closed behavior
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

describe("runGate — gate not configured (fail-closed)", () => {
  it("returns passed: false when gate command is not configured", () => {
    const flow = makeFlow(); // no gates
    const result = runGate("nonexistent-gate", flow, "/project");

    expect(result.passed).toBe(false);
    expect(result.command).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("includes fail-closed message in output when gate is not configured", () => {
    const flow = makeFlow();
    const result = runGate("nonexistent-gate", flow, "/project");

    expect(result.output).toContain("fail-closed");
    expect(result.output).toContain("nonexistent-gate");
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

    // Gate was not configured (null) — fail-closed
    expect(result.passed).toBe(false);
    expect(result.command).toBe("");
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

// ---------------------------------------------------------------------------
// normalizeGates — 3-tier resolution
// ---------------------------------------------------------------------------

describe("normalizeGates — no gates declared", () => {
  it("returns { commands: [], source: 'none' } when no gate, gates, or discovered_gates", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.commands).toEqual([]);
    expect(result.source).toBe("none");
  });

  it("returns 'none' when boardState is undefined", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const result = normalizeGates(stateDef, flow, "/project", undefined);

    expect(result.source).toBe("none");
  });

  it("returns 'none' when boardState has empty discovered_gates array", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState([]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("none");
  });

  it("returns 'none' when boardState has no discovered_gates field", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState(undefined);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("none");
  });
});

describe("normalizeGates — tier 1: explicit gates array", () => {
  it("returns gates array entries as direct commands", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["npm test", "npx tsc --noEmit"] });
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gates");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toEqual({ name: "npm test", command: "npm test" });
    expect(result.commands[1]).toEqual({ name: "npx tsc --noEmit", command: "npx tsc --noEmit" });
  });

  it("returns single gates array entry as direct command", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["echo hello"] });
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gates");
    expect(result.commands).toEqual([{ name: "echo hello", command: "echo hello" }]);
  });

  it("prefers explicit gates array over discovered_gates (tier 1 wins)", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["npm test"] });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("gates");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].command).toBe("npm test");
  });

  it("prefers explicit gates array over legacy gate field (tier 1 wins even if gate is also set)", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    // Both gates array and gate field present — gates array wins (tier 1)
    const stateDef = { type: "single" as const, gates: ["npm test"], gate: "lint" };
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gates");
    expect(result.commands[0].command).toBe("npm test");
  });
});

describe("normalizeGates — tier 2: legacy gate field", () => {
  it("wraps resolvable legacy gate name as resolved command", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    const stateDef = makeStateDef({ gate: "lint" });
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gate");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ name: "lint", command: "npm run lint" });
  });

  it("returns empty command string for unresolvable legacy gate (fails closed downstream)", () => {
    const flow = makeFlow(); // no gates map
    const stateDef = makeStateDef({ gate: "unknown-gate" });
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gate");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ name: "unknown-gate", command: "" });
  });

  it("prefers legacy gate over discovered_gates (tier 2 wins)", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    const stateDef = makeStateDef({ gate: "lint" });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("gate");
    expect(result.commands[0].command).toBe("npm run lint");
  });

  it("resolves test-suite legacy gate via built-in auto-detection", () => {
    readFileSyncImpl = () => JSON.stringify({ scripts: { test: "vitest run" } });
    const flow = makeFlow(); // no explicit gates map — uses built-in
    const stateDef = makeStateDef({ gate: "test-suite" });
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gate");
    expect(result.commands[0].command).toBe("npm test");
  });
});

describe("normalizeGates — tier 3: discovered gates are stored as metadata but NOT executed", () => {
  it("returns { commands: [], source: 'none' } when only discovered_gates exist (not executed)", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    // Discovered gates are stored on board for metadata but normalizeGates returns none
    expect(result.source).toBe("none");
    expect(result.commands).toEqual([]);
  });

  it("returns 'none' even when discovered_gates has multiple commands", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState([
      { command: "pytest", source: "tester" },
      { command: "npm run lint", source: "reviewer" },
    ]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("none");
    expect(result.commands).toEqual([]);
  });

  it("explicit gates still win over discovered when both present (tier 1 check still works)", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["npm test"] });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("gates");
    expect(result.commands[0].command).toBe("npm test");
  });

  it("legacy gate still wins over discovered when both present (tier 2 check still works)", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    const stateDef = makeStateDef({ gate: "lint" });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.source).toBe("gate");
    expect(result.commands[0].command).toBe("npm run lint");
  });
});

// ---------------------------------------------------------------------------
// runGates — multi-gate execution
// ---------------------------------------------------------------------------

describe("runGates — empty when no gates declared", () => {
  it("returns empty array when stateDef has no gate, gates, or discovered_gates", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const result = runGates(stateDef, flow, "/project");

    expect(result).toEqual([]);
  });

  it("returns empty array when boardState has empty discovered_gates", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState([]);
    const result = runGates(stateDef, flow, "/project", boardState);

    expect(result).toEqual([]);
  });
});

describe("runGates — multi-gate execution from explicit gates array", () => {
  it("runs all gates and returns array of results", () => {
    let callCount = 0;
    spawnSyncImpl = (cmd) => {
      callCount++;
      return { stdout: `output-${callCount}`, stderr: "", status: 0 };
    };
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["echo hello", "echo world"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
    expect(callCount).toBe(2);
  });

  it("executes direct shell commands from gates array — echo exits 0", () => {
    spawnSyncImpl = () => ({ stdout: "hello", stderr: "", status: 0 });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["echo hello"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].command).toBe("echo hello");
    expect(results[0].exitCode).toBe(0);
  });

  it("executes direct shell commands from gates array — false exits 1", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "", status: 1 });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["false"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].exitCode).toBe(1);
  });

  it("handles mixed pass/fail: one gate passes, one fails", () => {
    let callCount = 0;
    spawnSyncImpl = () => {
      callCount++;
      return { stdout: "", stderr: "", status: callCount === 1 ? 0 : 1 };
    };
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["echo ok", "false"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});

describe("runGates — fail-closed for unresolvable legacy named gate", () => {
  it("fails closed when legacy gate field references an unresolvable gate name", () => {
    const flow = makeFlow(); // no gates map
    const stateDef = makeStateDef({ gate: "nonexistent-gate" });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].command).toBe("");
    expect(results[0].output).toContain("fail-closed");
  });

  it("does NOT call spawnSync for unresolvable legacy gate", () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must not be called for unresolvable gate");
    };
    const flow = makeFlow();
    const stateDef = makeStateDef({ gate: "nonexistent-gate" });
    expect(() => runGates(stateDef, flow, "/project")).not.toThrow();
  });
});

describe("runGates — discovered gates are NOT executed (stored as metadata only)", () => {
  it("returns empty array when only discovered gates exist — they are not executed", () => {
    spawnSyncImpl = () => {
      throw new Error("spawnSync must NOT be called for discovered gates");
    };
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const results = runGates(stateDef, flow, "/project", boardState);

    // No execution — discovered gates are stored on board state but not run
    expect(results).toEqual([]);
  });

  it("returns empty array when board state has no discovered_gates", () => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const boardState = makeBoardState(undefined);
    const results = runGates(stateDef, flow, "/project", boardState);

    expect(results).toEqual([]);
  });

  it("still executes explicit gates even when discovered gates are also present", () => {
    spawnSyncImpl = () => ({ stdout: "ok", stderr: "", status: 0 });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["npm test"] });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const results = runGates(stateDef, flow, "/project", boardState);

    expect(results).toHaveLength(1);
    expect(results[0].command).toBe("npm test");
    expect(results[0].passed).toBe(true);
  });
});
