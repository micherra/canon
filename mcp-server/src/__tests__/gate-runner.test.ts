import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardStateEntry, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

// runShell mock — mutable implementation swapped per test
type RunShellResult = { ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut: boolean };
let runShellImpl: ((cmd: string, cwd: string, timeout?: number) => RunShellResult) | null = null;
let lastRunShellArgs: { cmd: string; cwd: string; timeout?: number } | null = null;

vi.mock("../adapters/process-adapter.ts", () => ({
  runShell: (cmd: string, cwd: string, timeout?: number) => {
    lastRunShellArgs = { cmd, cwd, timeout };
    if (runShellImpl) return runShellImpl(cmd, cwd, timeout);
    return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
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

import { normalizeGates, resolveGateCommand, runGate, runGates } from "../orchestration/gate-runner.ts";

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

function makeStateDef(
  overrides: Partial<{ gate: string; gates: string[] }> = {},
): Parameters<typeof normalizeGates>[0] {
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
  runShellImpl = null;
  readFileSyncImpl = null;
  lastRunShellArgs = null;
});

// ---------------------------------------------------------------------------
// resolveGateCommand
// ---------------------------------------------------------------------------

describe("resolveGateCommand — flow.gates map lookup", () => {
  it("returns command from flow.gates map when gate name is found", () => {
    const flow = makeFlow({ lint: "npm run lint", "type-check": "tsc --noEmit" });
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
    const flow = makeFlow({ lint: "npm run lint" });
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
    runShellImpl = () => ({ ok: true, stdout: "all tests passed", stderr: "", exitCode: 0, timedOut: false });
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
    runShellImpl = () => ({ ok: false, stdout: "", stderr: "2 tests failed", exitCode: 1, timedOut: false });
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

  it("does NOT call runShell when gate is not configured", () => {
    runShellImpl = () => {
      throw new Error("runShell must NOT be called for unconfigured gate");
    };
    const flow = makeFlow();
    // Should not throw — runShell is not called
    expect(() => runGate("nonexistent-gate", flow, "/project")).not.toThrow();
  });
});

describe("runGate — command injection protection", () => {
  it("does NOT execute an arbitrary gateName string as a shell command", () => {
    runShellImpl = () => {
      throw new Error("runShell must NOT be called for arbitrary gate name");
    };
    const flow = makeFlow(); // no gates map
    // Even though runShellImpl would throw if called, runGate must not call it
    const result = runGate("rm -rf /", flow, "/project");

    // Gate was not configured (null) — fail-closed
    expect(result.passed).toBe(false);
    expect(result.command).toBe("");
  });

  it("only executes the resolved command from flow.gates, not the gateName", () => {
    let executedCommand: string | null = null;
    runShellImpl = (cmd) => {
      executedCommand = cmd;
      return { ok: true, stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    };
    const flow = makeFlow({ "safe-gate": "npm run lint" });
    runGate("safe-gate", flow, "/project");

    // The command that reached runShell is the resolved value, not "safe-gate"
    expect(executedCommand).toBe("npm run lint");
    expect(executedCommand).not.toBe("safe-gate");
  });
});

describe("runGate — runShell timeout and cwd configuration", () => {
  it("passes 300_000 timeout to runShell", () => {
    runShellImpl = () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const flow = makeFlow({ "test-suite": "npm test" });
    runGate("test-suite", flow, "/project");

    expect(lastRunShellArgs).not.toBeNull();
    expect(lastRunShellArgs!.timeout).toBe(300_000);
  });

  it("passes cwd to runShell", () => {
    runShellImpl = () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const flow = makeFlow({ check: "tsc" });
    runGate("check", flow, "/my/project");

    expect(lastRunShellArgs!.cwd).toBe("/my/project");
  });

  it("uses process-adapter (runShell) not child_process directly", () => {
    // runShellImpl being called confirms gate-runner uses the adapter
    let adapterCalled = false;
    runShellImpl = () => {
      adapterCalled = true;
      return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const flow = makeFlow({ lint: "eslint ." });
    runGate("lint", flow, "/project");

    expect(adapterCalled).toBe(true);
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

  it.each([
    ["boardState is undefined", undefined],
    ["boardState has no discovered_gates field", makeBoardState(undefined)],
    ["boardState has empty discovered_gates array", makeBoardState([])],
  ])("returns 'none' when %s", (_label, boardState) => {
    const flow = makeFlow();
    const stateDef = makeStateDef();
    const result = normalizeGates(stateDef, flow, "/project", boardState);

    expect(result.commands).toEqual([]);
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
    const flow = makeFlow({ lint: "npm run lint" });
    // Both gates array and gate field present — gates array wins (tier 1)
    const stateDef = { type: "single" as const, gates: ["npm test"], gate: "lint" };
    const result = normalizeGates(stateDef, flow, "/project");

    expect(result.source).toBe("gates");
    expect(result.commands[0].command).toBe("npm test");
  });
});

describe("normalizeGates — tier 2: legacy gate field", () => {
  it("wraps resolvable legacy gate name as resolved command", () => {
    const flow = makeFlow({ lint: "npm run lint" });
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
    const flow = makeFlow({ lint: "npm run lint" });
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
    const flow = makeFlow({ lint: "npm run lint" });
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
    runShellImpl = (_cmd) => {
      callCount++;
      return { ok: true, stdout: `output-${callCount}`, stderr: "", exitCode: 0, timedOut: false };
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
    runShellImpl = () => ({ ok: true, stdout: "hello", stderr: "", exitCode: 0, timedOut: false });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["echo hello"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].command).toBe("echo hello");
    expect(results[0].exitCode).toBe(0);
  });

  it("executes direct shell commands from gates array — false exits 1", () => {
    runShellImpl = () => ({ ok: false, stdout: "", stderr: "", exitCode: 1, timedOut: false });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["false"] });
    const results = runGates(stateDef, flow, "/project");

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].exitCode).toBe(1);
  });

  it("handles mixed pass/fail: one gate passes, one fails", () => {
    let callCount = 0;
    runShellImpl = () => {
      callCount++;
      return { ok: callCount === 1, stdout: "", stderr: "", exitCode: callCount === 1 ? 0 : 1, timedOut: false };
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

  it("does NOT call runShell for unresolvable legacy gate", () => {
    runShellImpl = () => {
      throw new Error("runShell must not be called for unresolvable gate");
    };
    const flow = makeFlow();
    const stateDef = makeStateDef({ gate: "nonexistent-gate" });
    expect(() => runGates(stateDef, flow, "/project")).not.toThrow();
  });
});

describe("runGates — discovered gates are NOT executed (stored as metadata only)", () => {
  it("returns empty array when only discovered gates exist — they are not executed", () => {
    runShellImpl = () => {
      throw new Error("runShell must NOT be called for discovered gates");
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
    runShellImpl = () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const flow = makeFlow();
    const stateDef = makeStateDef({ gates: ["npm test"] });
    const boardState = makeBoardState([{ command: "pytest", source: "tester" }]);
    const results = runGates(stateDef, flow, "/project", boardState);

    expect(results).toHaveLength(1);
    expect(results[0].command).toBe("npm test");
    expect(results[0].passed).toBe(true);
  });
});
