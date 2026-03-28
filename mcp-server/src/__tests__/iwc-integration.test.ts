/**
 * Inter-wave communication system — integration tests and coverage gap fills.
 *
 * Covers:
 * 1. Cross-module integration: wave-variables escaping → assembleWaveBriefing
 *    (declared gap in iwc-05 Coverage Notes)
 * 2. Cross-module: consultation-executor → recordConsultationResult round-trip
 * 3. Cross-module: runGate → recordGateResult round-trip on board
 * 4. gate-runner coverage gaps: null status from spawnSync, scripts.test=""
 * 5. board.ts coverage gaps: recordGateResult preserving existing consultations,
 *    recordConsultationResult on a nonexistent state key
 * 6. wave-briefing: line matching multiple classifiers (duplication check),
 *    multiple summaries aggregated correctly
 * 7. consultation-executor: breakpoint field routing (informational metadata flows through)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// ---------------------------------------------------------------------------
// Hoist spawnSync mock — gate-runner uses child_process
// ---------------------------------------------------------------------------

type SpawnSyncArgs = { shell?: boolean; cwd?: string; encoding?: string; timeout?: number };
let spawnSyncImpl: ((cmd: string, opts: SpawnSyncArgs) => { stdout: string; stderr: string; status: number | null; error?: Error }) | null = null;
vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, opts: SpawnSyncArgs) => {
    if (spawnSyncImpl) return spawnSyncImpl(cmd, opts);
    return { stdout: "", stderr: "", status: 0 };
  },
}));

let readFileSyncImpl: ((path: string, enc: string) => string) | null = null;

vi.mock("node:fs", () => ({
  readFileSync: (path: string, enc: string) => {
    if (readFileSyncImpl) return readFileSyncImpl(path, enc);
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { resolveGateCommand, runGate } from "../orchestration/gate-runner.ts";
import {
  initBoard,
  recordConsultationResult,
  recordGateResult,
} from "../orchestration/board.ts";
import {
  executeConsultations,
  resolveConsultationPrompt,
  type ConsultationInput,
} from "../orchestration/consultation-executor.ts";
import { assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import type { ResolvedFlow, Board, ConsultationResult } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(gates?: Record<string, string>): ResolvedFlow {
  return {
    name: "integration-flow",
    description: "IWC integration test flow",
    entry: "implement",
    states: {
      implement: { type: "single", agent: "canon-implementor" },
      ship: { type: "terminal" },
    },
    spawn_instructions: { implement: "Implement the feature." },
    ...(gates ? { gates } : {}),
  };
}

function makeConsultationFlow(): ResolvedFlow {
  return {
    name: "consultation-flow",
    description: "Flow with consultations",
    entry: "build",
    states: { build: { type: "single", agent: "canon-implementor" } },
    spawn_instructions: {
      "security-check": "Run security audit for ${task}.",
      "arch-review": "Review architecture for ${task}.",
    },
    consultations: {
      "security-check": {
        fragment: "security-check",
        agent: "canon:canon-security",
        role: "security",
        section: "Security findings",
        timeout: "5m",
      },
      "arch-review": {
        fragment: "arch-review",
        agent: "canon:canon-architect",
        role: "architect",
        section: "Architecture review",
      },
    },
  };
}

function makeBoard(): Board {
  return initBoard(makeFlow(), "IWC integration task", "abc123");
}

beforeEach(() => {
  spawnSyncImpl = null;
  readFileSyncImpl = null;
});

afterEach(() => {
});

// ---------------------------------------------------------------------------
// 1. Cross-module integration: wave-variables escaping → assembleWaveBriefing
//    This is the declared gap from iwc-05 Coverage Notes.
// ---------------------------------------------------------------------------

describe("integration: wave-variables escapeDollarBrace → assembleWaveBriefing", () => {
  it("escaped ${...} from wave-variables passes through wave-briefing without double-escaping", () => {
    // Simulate what resolveWaveVariables produces: text with \${...} patterns
    const rawSummaryFromAgent = "Pattern: use ${template_name} in all new files";
    const escapedSummary = escapeDollarBrace(rawSummaryFromAgent);
    // escapeDollarBrace turns ${template_name} into \${template_name}
    expect(escapedSummary).toBe("Pattern: use \\${template_name} in all new files");

    const result = assembleWaveBriefing({
      wave: 2,
      summaries: [escapedSummary],
      consultationOutputs: {},
    });

    // The escaped pattern must survive wave-briefing unchanged — no double-escape
    expect(result).toContain("\\${template_name}");
    expect(result).not.toContain("\\\\${template_name}");
    // Also must not contain unescaped ${
    expect(result).not.toMatch(/(^|[^\\])\$\{template_name\}/m);
  });

  it("consultation output with escaped ${...} also passes through without double-escaping", () => {
    const rawConsultation = "Security: validate ${user_input} before processing";
    const escapedConsultation = escapeDollarBrace(rawConsultation);

    const result = assembleWaveBriefing({
      wave: 3,
      summaries: [],
      consultationOutputs: {
        "sec-review": {
          section: "Security notes",
          summary: escapedConsultation,
        },
      },
    });

    expect(result).toContain("\\${user_input}");
    expect(result).not.toContain("\\\\${user_input}");
  });

  it("multiple summaries with injection patterns are all escaped once", () => {
    const summary1 = escapeDollarBrace("created src/util.ts — replaces ${OLD_VAR}");
    const summary2 = escapeDollarBrace("pattern: always escape ${env_var} in templates");

    const result = assembleWaveBriefing({
      wave: 2,
      summaries: [summary1, summary2],
      consultationOutputs: {},
    });

    // Each escaped pattern present exactly once (no duplication in escaping)
    expect(result).toContain("\\${OLD_VAR}");
    expect(result).toContain("\\${env_var}");
    // No double backslash from assembleWaveBriefing re-processing
    expect(result.match(/\\\\\$/g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-module: executeConsultations → recordConsultationResult round-trip
//    Tests the full consultation prep → board storage pipeline
// ---------------------------------------------------------------------------

describe("integration: executeConsultations result → recordConsultationResult on board", () => {
  it("pending results from executeConsultations can be stored on the board via recordConsultationResult", async () => {
    const flow = makeConsultationFlow();
    const input: ConsultationInput = {
      consultationNames: ["security-check"],
      breakpoint: "before",
      flow,
      variables: { task: "deploy-auth" },
    };

    const { results, warnings } = await executeConsultations(input);
    expect(warnings).toHaveLength(0);
    expect(results["security-check"]).toEqual({ status: "pending" });

    const board = makeBoard();
    const updatedBoard = recordConsultationResult(
      board,
      "implement",
      "wave_1",
      "before",
      "security-check",
      results["security-check"],
    );

    const stored = updatedBoard.states.implement.wave_results?.["wave_1"]?.consultations?.before?.["security-check"];
    expect(stored).toEqual({ status: "pending" });
  });

  it("multiple consultation results can be stored at different breakpoints on the same wave", async () => {
    const flow = makeConsultationFlow();

    const beforeInput: ConsultationInput = {
      consultationNames: ["security-check"],
      breakpoint: "before",
      flow,
      variables: { task: "my-task" },
    };

    const afterInput: ConsultationInput = {
      consultationNames: ["arch-review"],
      breakpoint: "after",
      flow,
      variables: { task: "my-task" },
    };

    const beforeOutput = await executeConsultations(beforeInput);
    const afterOutput = await executeConsultations(afterInput);

    let board = makeBoard();
    board = recordConsultationResult(board, "implement", "wave_1", "before", "security-check", beforeOutput.results["security-check"]);
    board = recordConsultationResult(board, "implement", "wave_1", "after", "arch-review", afterOutput.results["arch-review"]);

    const waveResult = board.states.implement.wave_results?.["wave_1"];
    expect(waveResult?.consultations?.before?.["security-check"]).toEqual({ status: "pending" });
    expect(waveResult?.consultations?.after?.["arch-review"]).toEqual({ status: "pending" });
  });

  it("resolved prompt from resolveConsultationPrompt contains the variable-substituted content", () => {
    const flow = makeConsultationFlow();
    const resolved = resolveConsultationPrompt("security-check", flow, { task: "payment-service" });

    expect(resolved).not.toBeNull();
    expect(resolved!.prompt).toBe("Run security audit for payment-service.");
    expect(resolved!.agent).toBe("canon:canon-security");
    expect(resolved!.role).toBe("security");
  });

  it("breakpoint metadata in ConsultationInput is preserved (informational — not discarded)", async () => {
    const flow = makeConsultationFlow();

    // The 'between' breakpoint should produce the same pending result regardless —
    // it is used by the orchestrator for routing, not by executeConsultations itself.
    const betweenOutput = await executeConsultations({
      consultationNames: ["security-check"],
      breakpoint: "between",
      flow,
      variables: {},
    });

    expect(betweenOutput.warnings).toHaveLength(0);
    expect(betweenOutput.results["security-check"]).toEqual({ status: "pending" });

    // Orchestrator routes it using the breakpoint:
    const board = makeBoard();
    const stored = recordConsultationResult(
      board, "implement", "wave_1", "between", "security-check", betweenOutput.results["security-check"],
    );
    expect(
      stored.states.implement.wave_results?.["wave_1"]?.consultations?.between?.["security-check"],
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-module: runGate → recordGateResult round-trip on board
// ---------------------------------------------------------------------------

describe("integration: runGate result → recordGateResult on board", () => {
  it("passed gate result can be stored on the board", () => {
    spawnSyncImpl = () => ({ stdout: "All tests passed", stderr: "", status: 0 });
    const flow = makeFlow({ "test-suite": "npm test" });
    const gateResult = runGate("test-suite", flow, "/project");

    expect(gateResult.passed).toBe(true);

    const board = makeBoard();
    const updatedBoard = recordGateResult(
      board,
      "implement",
      "wave_1",
      gateResult.gate,
      gateResult.output,
    );

    const waveResult = updatedBoard.states.implement.wave_results?.["wave_1"];
    expect(waveResult?.gate).toBe("test-suite");
    expect(waveResult?.gate_output).toBe("All tests passed");
  });

  it("failed gate result stored with FAIL output for audit trail", () => {
    spawnSyncImpl = () => ({ stdout: "", stderr: "3 tests failed", status: 1 });
    const flow = makeFlow({ "test-suite": "npm test" });
    const gateResult = runGate("test-suite", flow, "/project");

    expect(gateResult.passed).toBe(false);

    const board = makeBoard();
    const updatedBoard = recordGateResult(
      board,
      "implement",
      "wave_1",
      gateResult.gate,
      gateResult.output,
    );

    const waveResult = updatedBoard.states.implement.wave_results?.["wave_1"];
    expect(waveResult?.gate).toBe("test-suite");
    expect(waveResult?.gate_output).toBe("3 tests failed");
  });

  it("unconfigured gate result (fail-closed) stores fail-closed message on board", () => {
    const flow = makeFlow(); // no gates
    const gateResult = runGate("nonexistent-gate", flow, "/project");

    expect(gateResult.passed).toBe(false); // fail-closed — unconfigured gate fails
    expect(gateResult.output).toContain("fail-closed");

    const board = makeBoard();
    const updatedBoard = recordGateResult(
      board, "implement", "wave_1", gateResult.gate, gateResult.output,
    );

    const waveResult = updatedBoard.states.implement.wave_results?.["wave_1"];
    expect(waveResult?.gate_output).toContain("fail-closed");
  });
});

// ---------------------------------------------------------------------------
// 4. gate-runner coverage gaps
// ---------------------------------------------------------------------------

describe("gate-runner — spawnSync null status (timeout/kill)", () => {
  it("treats null exit status as non-zero (passed: false)", () => {
    // spawnSync returns status: null when process is killed (e.g. by SIGKILL / timeout)
    spawnSyncImpl = () => ({ stdout: "", stderr: "Process killed", status: null as unknown as number });
    const flow = makeFlow({ "test-suite": "npm test" });
    const result = runGate("test-suite", flow, "/project");

    // status ?? 1 means null → exitCode=1 → passed=false
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("combines non-empty stdout and stderr into combined output", () => {
    spawnSyncImpl = () => ({ stdout: "Build output line", stderr: "Warning: deprecated API", status: 0 });
    const flow = makeFlow({ "build": "npm run build" });
    const result = runGate("build", flow, "/project");

    expect(result.output).toContain("Build output line");
    expect(result.output).toContain("Warning: deprecated API");
    expect(result.passed).toBe(true);
  });
});

describe("gate-runner — resolveTestSuiteCommand: scripts.test is empty string", () => {
  it("falls back to 'make test' when scripts.test is an empty string", () => {
    // package.json exists but scripts.test is ""  — falsy, should NOT return "npm test"
    readFileSyncImpl = () => JSON.stringify({ scripts: { test: "" } });
    const flow = makeFlow();
    const result = resolveGateCommand("test-suite", flow, "/project");
    expect(result).toBe("make test");
  });
});

// ---------------------------------------------------------------------------
// 5. board.ts coverage gaps
// ---------------------------------------------------------------------------

describe("board — recordGateResult preserves existing consultations", () => {
  it("recordGateResult does not discard pre-existing consultations on the same wave_result", () => {
    let board = makeBoard();

    // First record a consultation result
    const consultationResult: ConsultationResult = { status: "done", summary: "Looks good" };
    board = recordConsultationResult(board, "implement", "wave_1", "before", "sec-check", consultationResult);

    // Then record a gate result on the same wave
    board = recordGateResult(board, "implement", "wave_1", "quality-gate", "PASS");

    const waveResult = board.states.implement.wave_results?.["wave_1"];
    // Gate recorded
    expect(waveResult?.gate).toBe("quality-gate");
    expect(waveResult?.gate_output).toBe("PASS");
    // Consultation still present — recordGateResult must spread existing wave_result
    expect(waveResult?.consultations?.before?.["sec-check"]).toEqual(consultationResult);
  });
});

describe("board — recordConsultationResult on a state not in board.states", () => {
  it("creates a new state entry when the stateId does not exist in board.states", () => {
    const board = makeBoard();
    // "nonexistent-state" is NOT in makeBoard()'s flow states
    const result = recordConsultationResult(
      board,
      "nonexistent-state",
      "wave_1",
      "after",
      "my-consult",
      { status: "pending" },
    );

    // A new state entry must be created from scratch
    expect(result.states["nonexistent-state"]).toBeDefined();
    const stored = result.states["nonexistent-state"].wave_results?.["wave_1"]?.consultations?.after?.["my-consult"];
    expect(stored).toEqual({ status: "pending" });
    // Original board must not be mutated
    expect(board.states["nonexistent-state"]).toBeUndefined();
  });

  it("creates a new state entry for recordGateResult on unknown stateId", () => {
    const board = makeBoard();
    const result = recordGateResult(board, "new-state", "wave_1", "lint", "0 errors");

    expect(result.states["new-state"]).toBeDefined();
    expect(result.states["new-state"].wave_results?.["wave_1"]?.gate).toBe("lint");
    expect(result.states["new-state"].wave_results?.["wave_1"]?.gate_output).toBe("0 errors");
    // Original board not mutated
    expect(board.states["new-state"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. wave-briefing: line matching multiple section classifiers
// ---------------------------------------------------------------------------

describe("wave-briefing — lines matching multiple classifiers", () => {
  it("a line matching both 'created' and 'pattern' appears in both sections", () => {
    // Line contains both keywords — both classifiers should fire
    const input = {
      wave: 2,
      summaries: ["created a pattern for barrel exports in src/index.ts"],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    // The line should appear in New shared code (has "created", file path)
    expect(result).toContain("### New shared code");
    // The line should ALSO appear in Patterns established (has "pattern")
    expect(result).toContain("### Patterns established");
  });

  it("a line matching 'concern' and file path appears in both Gotchas and New shared code", () => {
    const input = {
      wave: 1,
      summaries: ["concern: src/parser.ts may have edge case with empty input"],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("### Gotchas");
    // "src/parser.ts" matches isNewSharedCodeLine
    expect(result).toContain("### New shared code");
  });
});

describe("wave-briefing — multiple summaries aggregate correctly", () => {
  it("sections from different summaries are merged into one briefing", () => {
    const input = {
      wave: 3,
      summaries: [
        "created src/gate-runner.ts with runGate export",
        "pattern: all gate commands resolved via lookup, never raw string",
        "added mcp-server/src/tools/check-gate.ts",
        "concern: spawnSync blocks the event loop",
      ],
      consultationOutputs: {
        "perf-review": {
          section: "Performance notes",
          summary: "Gate timeout is 300s — acceptable for CI.",
        },
      },
    };

    const result = assembleWaveBriefing(input);

    // All sections present
    expect(result).toContain("### New shared code");
    expect(result).toContain("src/gate-runner.ts");
    expect(result).toContain("mcp-server/src/tools/check-gate.ts");
    expect(result).toContain("### Patterns established");
    expect(result).toContain("gate commands resolved via lookup");
    expect(result).toContain("### Gotchas");
    expect(result).toContain("blocks the event loop");
    expect(result).toContain("### Performance notes");
    expect(result).toContain("Gate timeout is 300s");
  });

  it("wave number is correct in briefing header when wave > 1", () => {
    const result = assembleWaveBriefing({
      wave: 5,
      summaries: ["added src/module.ts"],
      consultationOutputs: {},
    });

    expect(result).toContain("## Wave Briefing (from wave 5)");
  });
});

// ---------------------------------------------------------------------------
// 7. Consultation executor — resolveConsultationPrompt with no variables (all unresolved)
// ---------------------------------------------------------------------------

describe("consultation-executor — resolveConsultationPrompt edge cases", () => {
  it("resolves prompt when consultations map is present but empty for the requested name (returns null)", () => {
    const flow: ResolvedFlow = {
      name: "f",
      description: "d",
      entry: "s",
      states: { s: { type: "terminal" } },
      spawn_instructions: {},
      consultations: {},
    };

    const result = resolveConsultationPrompt("any-name", flow, {});
    expect(result).toBeNull();
  });

  it("handles flow with no consultations field (undefined) and returns null", () => {
    const flow: ResolvedFlow = {
      name: "f",
      description: "d",
      entry: "s",
      states: { s: { type: "terminal" } },
      spawn_instructions: { "sec": "Run audit." },
      // consultations: undefined
    };

    const result = resolveConsultationPrompt("sec", flow, {});
    expect(result).toBeNull();
  });

  it("executeConsultations with flow having no consultations field returns warning for every name", async () => {
    const flow: ResolvedFlow = {
      name: "f",
      description: "d",
      entry: "s",
      states: { s: { type: "terminal" } },
      spawn_instructions: {},
      // consultations: undefined
    };

    const output = await executeConsultations({
      consultationNames: ["foo", "bar"],
      breakpoint: "after",
      flow,
      variables: {},
    });

    expect(output.warnings).toHaveLength(2);
    expect(Object.keys(output.results)).toHaveLength(0);
  });
});
