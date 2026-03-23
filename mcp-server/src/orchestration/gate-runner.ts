/**
 * Gate runner — resolves and executes flow gates.
 *
 * Security note: The gate string (gateName) is NEVER executed as a shell command.
 * It is a lookup key into flow.gates or the built-in gate registry.
 * Only the resolved command (from the map or built-in resolution) reaches the shell.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedFlow } from "./flow-schema.js";

export interface GateResult {
  passed: boolean;
  gate: string;
  command: string;
  output: string; // stdout + stderr combined
  exitCode: number;
}

/**
 * Resolve a gate name to a shell command.
 *
 * 1. If flow.gates exists and has the key, return that command.
 * 2. If gateName is "test-suite", auto-detect from package.json scripts.test.
 * 3. Otherwise return null (gate is not configured — caller should skip).
 */
export function resolveGateCommand(
  gateName: string,
  flow: ResolvedFlow,
  cwd?: string,
): string | null {
  // 1. Check flow.gates map first
  if (flow.gates && Object.prototype.hasOwnProperty.call(flow.gates, gateName)) {
    return flow.gates[gateName];
  }

  // 2. Built-in: "test-suite" auto-detection
  if (gateName === "test-suite") {
    return resolveTestSuiteCommand(cwd ?? process.cwd());
  }

  // 3. Not found
  return null;
}

/**
 * Auto-detect the test command for the "test-suite" built-in gate.
 * Checks package.json scripts.test, then falls back to make test / pytest.
 */
function resolveTestSuiteCommand(cwd: string): string {
  // Try package.json
  try {
    const pkgPath = join(cwd, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts && typeof scripts.test === "string" && scripts.test) {
      return "npm test";
    }
  } catch {
    // package.json not found or not parseable — continue to fallbacks
  }

  // Fallback: make test
  return "make test";
}

/**
 * Run a named gate in the given working directory.
 *
 * If the gate command cannot be resolved, the gate is skipped gracefully
 * (returned as passed: true so the orchestrator can continue).
 */
export function runGate(
  gateName: string,
  flow: ResolvedFlow,
  cwd: string,
): GateResult {
  const command = resolveGateCommand(gateName, flow, cwd);

  // Gate not configured — skip gracefully
  if (command === null) {
    return {
      passed: true,
      gate: gateName,
      command: "",
      output: "Gate not configured — skipped",
      exitCode: 0,
    };
  }

  const result = spawnSync(command, {
    shell: true,
    cwd,
    encoding: "utf-8",
    timeout: 300_000,
  });

  const stdout: string = result.stdout ?? "";
  const stderr: string = result.stderr ?? "";
  const output = (stdout + stderr).trim();
  const exitCode: number = result.status ?? 1;

  return {
    passed: exitCode === 0,
    gate: gateName,
    command,
    output,
    exitCode,
  };
}
