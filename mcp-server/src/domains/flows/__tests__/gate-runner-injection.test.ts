/**
 * gate-runner-injection.test.ts
 *
 * Verifies that runGates() and runGate() use the injected shellRunner parameter
 * when provided, instead of the concrete runShell adapter.
 *
 * These tests exercise the DI seam without vi.mock — they pass mock functions
 * directly as the optional 5th / 4th argument.
 */

import { stateId as sid, flowName } from "@domains/flows/board-state-schemas.ts";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedFlow } from "../flow-definition-schemas.ts";
import type { ShellRunner } from "../gate-runner.ts";
import { runGate, runGates } from "../gate-runner.ts";

// Minimal flow with a named gate
function makeFlow(gates?: Record<string, string>): ResolvedFlow {
  return {
    description: "test",
    entry: sid("start"),
    name: flowName("injection-test-flow"),
    spawn_instructions: {},
    states: {},
    ...(gates ? { gates } : {}),
  };
}

function makeProcessResult(overrides: Partial<ReturnType<ShellRunner>> = {}): ReturnType<ShellRunner> {
  return {
    duration_ms: 0,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// runGate — injection
// -------------------------------------------------------------------------

describe("runGate — uses injected shellRunner when provided", () => {
  it("calls the injected runner with the resolved command and cwd", () => {
    const flow = makeFlow({ "custom-gate": "echo hello" });
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult({ stdout: "hello", exitCode: 0, ok: true }));

    const result = runGate("custom-gate", flow, "/my/project", mockRunner);

    expect(mockRunner).toHaveBeenCalledOnce();
    expect(mockRunner).toHaveBeenCalledWith("echo hello", "/my/project", 300_000);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("custom-gate");
    expect(result.command).toBe("echo hello");
  });

  it("returns passed: false when injected runner returns non-zero exit code", () => {
    const flow = makeFlow({ "lint": "npm run lint" });
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult({ exitCode: 1, ok: false, stdout: "lint error" }));

    const result = runGate("lint", flow, "/project", mockRunner);

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("lint error");
  });

  it("does NOT call the injected runner for an unresolved gate (fail-closed)", () => {
    const flow = makeFlow();
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult());

    const result = runGate("nonexistent-gate", flow, "/project", mockRunner);

    expect(mockRunner).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.output).toContain("not configured");
  });

  it("includes stdout and stderr in output", () => {
    const flow = makeFlow({ "check": "check-cmd" });
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(
      makeProcessResult({ stdout: "out-data", stderr: "err-data", exitCode: 0, ok: true }),
    );

    const result = runGate("check", flow, "/project", mockRunner);

    expect(result.output).toContain("out-data");
    expect(result.output).toContain("err-data");
  });
});

// -------------------------------------------------------------------------
// runGates — injection
// -------------------------------------------------------------------------

describe("runGates — uses injected shellRunner when provided", () => {
  it("passes the runner to each gate in the explicit gates array", () => {
    const flow = makeFlow();
    const stateDef = { type: "single" as const, gates: ["echo gate1", "echo gate2"] };
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult({ exitCode: 0, ok: true }));

    const results = runGates(stateDef, flow, "/project", undefined, mockRunner);

    expect(mockRunner).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("returns passed: false for a failing gate using injected runner", () => {
    const flow = makeFlow();
    const stateDef = { type: "single" as const, gates: ["failing-cmd"] };
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(
      makeProcessResult({ exitCode: 2, ok: false, stderr: "command failed" }),
    );

    const results = runGates(stateDef, flow, "/project", undefined, mockRunner);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].exitCode).toBe(2);
  });

  it("returns empty array when no gates declared (runner never called)", () => {
    const flow = makeFlow();
    const stateDef = { type: "single" as const };
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult());

    const results = runGates(stateDef, flow, "/project", undefined, mockRunner);

    expect(mockRunner).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it("calls runner with correct cwd and 300_000 timeout for each gate", () => {
    const flow = makeFlow();
    const stateDef = { type: "single" as const, gates: ["npm test"] };
    const mockRunner = vi.fn<ShellRunner>().mockReturnValue(makeProcessResult());

    runGates(stateDef, flow, "/specific/cwd", undefined, mockRunner);

    expect(mockRunner).toHaveBeenCalledWith("npm test", "/specific/cwd", 300_000);
  });
});
