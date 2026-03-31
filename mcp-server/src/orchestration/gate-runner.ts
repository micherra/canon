/**
 * Gate runner — resolves and executes flow gates.
 *
 * Security note: The gate string (gateName) is NEVER executed as a shell command.
 * It is a lookup key into flow.gates or the built-in gate registry.
 * Only the resolved command (from the map or built-in resolution) reaches the shell.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runShell } from "../adapters/process-adapter.ts";
import type { GateResult, StateDefinition, ResolvedFlow, BoardStateEntry } from "./flow-schema.ts";

// GateResult is the source of truth from flow-schema.ts — no local interface needed.
export type { GateResult };

/**
 * Resolve a gate name to a shell command.
 *
 * 1. If flow.gates exists and has the key, return that command.
 * 2. If gateName is "test-suite", auto-detect from package.json scripts.test.
 * 3. Otherwise return null (gate is not configured — caller should fail-closed).
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
 * Fail-closed: if the gate command cannot be resolved, the gate fails
 * (returned as passed: false). This prevents silent quality gate bypasses.
 */
export function runGate(
  gateName: string,
  flow: ResolvedFlow,
  cwd: string,
): GateResult {
  const command = resolveGateCommand(gateName, flow, cwd);

  // Gate not configured — fail-closed (never silently pass an unresolved gate)
  if (command === null) {
    return {
      passed: false,
      gate: gateName,
      command: "",
      output: `Gate '${gateName}' not configured — failed (fail-closed)`,
      exitCode: 1,
    };
  }

  const result = runShell(command, cwd, 300_000);
  const output = (result.stdout + result.stderr).trim();

  return {
    passed: result.exitCode === 0,
    gate: gateName,
    command,
    output,
    exitCode: result.exitCode,
  };
}

/**
 * Normalize gate declarations into executable commands.
 * 3-tier priority:
 *   1. Explicit `gates` array on stateDef: direct shell commands (language-agnostic)
 *   2. Legacy `gate` field on stateDef: named reference resolved via resolveGateCommand()
 *   3. Discovered gates: accumulated from agent reports on board state
 * Returns the first non-empty tier.
 */
export function normalizeGates(
  stateDef: StateDefinition,
  flow: ResolvedFlow,
  cwd: string,
  _boardState?: BoardStateEntry,
): { commands: Array<{ name: string; command: string }>; source: "gates" | "gate" | "discovered" | "none" } {
  // Tier 1: Explicit gates array — direct shell commands
  if (stateDef.gates?.length) {
    return {
      commands: stateDef.gates.map(cmd => ({ name: cmd, command: cmd })),
      source: "gates",
    };
  }

  // Tier 2: Legacy gate field — named reference, resolve via map/built-in
  if (stateDef.gate) {
    const resolved = resolveGateCommand(stateDef.gate, flow, cwd);
    if (resolved === null) {
      return {
        commands: [{ name: stateDef.gate, command: "" }],
        source: "gate",
      };
    }
    return {
      commands: [{ name: stateDef.gate, command: resolved }],
      source: "gate",
    };
  }

  // Tier 3: Discovered gates are stored on board state as metadata but NOT executed.
  // Agent-discovered gates provide useful context (recorded by report_result) but only
  // YAML-defined gates (tiers 1 and 2) are executed — this prevents agent-injected
  // arbitrary commands from running via the gate runner.
  // (boardState?.discovered_gates are intentionally ignored here)

  return { commands: [], source: "none" };
}

/**
 * Run all gates declared on a state definition.
 * Executes whatever normalizeGates() returns — explicit gates array, legacy named gate,
 * or discovered gates from board state. Returns empty array when no gates declared.
 */
export function runGates(
  stateDef: StateDefinition,
  flow: ResolvedFlow,
  cwd: string,
  boardState?: BoardStateEntry,
): GateResult[] {
  const normalized = normalizeGates(stateDef, flow, cwd, boardState);
  if (normalized.commands.length === 0) return [];

  return normalized.commands.map(({ name, command }) => {
    if (!command) {
      return {
        passed: false,
        gate: name,
        command: "",
        output: `Gate '${name}' not configured — failed (fail-closed)`,
        exitCode: 1,
      };
    }

    const result = runShell(command, cwd, 300_000);
    const output = (result.stdout + result.stderr).trim();

    return {
      passed: result.exitCode === 0,
      gate: name,
      command,
      output,
      exitCode: result.exitCode,
    };
  });
}
