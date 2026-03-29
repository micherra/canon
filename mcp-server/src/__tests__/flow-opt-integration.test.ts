/**
 * Integration tests for the 4 medium-effort flow optimizations:
 *   flow-opt-01: conditional consultations (min_waves)
 *   flow-opt-02: scoped re-review (review_scope)
 *   flow-opt-03: explore optional deps
 *   flow-opt-04: auto_approved skip_when
 *
 * These tests cover:
 * 1. Disk-load integration — fragment YAML parsed through full pipeline
 * 2. Cross-feature integration — min_waves + scoped re-review in same flow
 * 3. End-to-end auto_approved through enterAndPrepareState
 * 4. Regression guard — affected flows still load cleanly
 *
 * Note: evaluateSkipWhen edge cases (truthy non-boolean auto_approve) are
 * covered in skip-when.test.ts where the real function is imported.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../.."); // mcp-server/src/__tests__ → project root

// ---------------------------------------------------------------------------
// Mocks for enterAndPrepareState tests
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.ts", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
  enterState: vi.fn(),
}));

vi.mock("../orchestration/workspace.ts", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.ts", () => ({
  createJsonlLogger: vi.fn(() => vi.fn()),
}));

vi.mock("../orchestration/wave-briefing.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../orchestration/wave-briefing.ts")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn((name: string, flow: unknown) => {
    // Return a minimal resolved consultation for testing
    const flowTyped = flow as { consultations?: Record<string, { agent: string; role: string }> };
    const fragment = flowTyped?.consultations?.[name];
    if (!fragment) return undefined;
    return {
      agent: fragment.agent,
      role: fragment.role,
      prompt: `Consultation: ${name}`,
    };
  }),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { readBoard, enterState } from "../orchestration/board.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-opt-integ-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "review",
    current_state: "review",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      review: { status: "pending", entries: 0 },
      done: { status: "pending", entries: 0 },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ===========================================================================
// 1. REGRESSION GUARD — affected flows still load cleanly
// ===========================================================================

describe("affected flows load without errors after all optimizations", () => {
  it("feature.md loads cleanly", async () => {
    const result = await loadAndResolveFlow(pluginDir, "feature");
    expect(result.errors).toHaveLength(0);
  });

  it("epic.md loads cleanly", async () => {
    const result = await loadAndResolveFlow(pluginDir, "epic");
    expect(result.errors).toHaveLength(0);
  });

  it("explore.md loads cleanly", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    expect(result.errors).toHaveLength(0);
  });

  it("refactor.md loads cleanly", async () => {
    const result = await loadAndResolveFlow(pluginDir, "refactor");
    expect(result.errors).toHaveLength(0);
  });

  it("migrate.md loads cleanly", async () => {
    const result = await loadAndResolveFlow(pluginDir, "migrate");
    expect(result.errors).toHaveLength(0);
  });
});

// ===========================================================================
// 2. DISK-LOAD INTEGRATION — skip_when: auto_approved from user-checkpoint fragment
// ===========================================================================

describe("disk-load: user-checkpoint fragment resolves skip_when: auto_approved", () => {
  it("feature.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const result = await loadAndResolveFlow(pluginDir, "feature");
    expect(result.errors).toHaveLength(0);

    const checkpointState = result.flow.states["checkpoint"];
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });

  it("epic.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const result = await loadAndResolveFlow(pluginDir, "epic");
    expect(result.errors).toHaveLength(0);

    const checkpointState = result.flow.states["checkpoint"];
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });

  it("refactor.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const result = await loadAndResolveFlow(pluginDir, "refactor");
    expect(result.errors).toHaveLength(0);

    const checkpointState = result.flow.states["checkpoint"];
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });
});

// ===========================================================================
// 3. DISK-LOAD INTEGRATION — min_waves on consultation fragments
//    NOTE: This test suite documents a known implementation gap:
//    FragmentDefinitionSchema does not include min_waves, so it is dropped
//    during fragment parsing. The test asserts current behavior and will need
//    to be updated when the bug is fixed.
// ===========================================================================

describe("disk-load: epic flow consultation fragments from disk", () => {
  it("epic flow consultations map contains pattern-check after disk load", async () => {
    const result = await loadAndResolveFlow(pluginDir, "epic");
    expect(result.errors).toHaveLength(0);

    const consultations = result.flow.consultations;
    expect(consultations).toBeDefined();
    expect(consultations!["pattern-check"]).toBeDefined();
    // Verify agent and role are correctly resolved from fragment YAML
    expect(consultations!["pattern-check"].agent).toBe("canon-architect");
    expect(consultations!["pattern-check"].role).toBe("pattern-check");
  });

  it("epic flow consultations map contains early-scan after disk load", async () => {
    const result = await loadAndResolveFlow(pluginDir, "epic");
    expect(result.errors).toHaveLength(0);

    const consultations = result.flow.consultations;
    expect(consultations!["early-scan"]).toBeDefined();
    expect(consultations!["early-scan"].agent).toBe("canon-security");
    expect(consultations!["early-scan"].role).toBe("early-scan");
  });

  it("epic implement state references pattern-check and early-scan in between breakpoint", async () => {
    const result = await loadAndResolveFlow(pluginDir, "epic");
    expect(result.errors).toHaveLength(0);

    const implementState = result.flow.states["implement"];
    expect(implementState).toBeDefined();
    const between = implementState.consultations?.between;
    expect(between).toContain("pattern-check");
    expect(between).toContain("early-scan");
  });
});

// ===========================================================================
// 4. END-TO-END — auto_approved skip through enterAndPrepareState
//    (flow-opt-04 declared known gap: no integration test with full board fixture)
// ===========================================================================

describe("enterAndPrepareState — auto_approved skip integration", () => {
  function makeCheckpointFlow(): ResolvedFlow {
    return {
      name: "test-flow",
      description: "Test flow with checkpoint",
      entry: "checkpoint",
      states: {
        checkpoint: {
          type: "single",
          agent: "canon-guide",
          skip_when: "auto_approved",
          transitions: {
            approved: "done",
          },
        },
        done: { type: "terminal" },
      },
      spawn_instructions: {
        checkpoint: "Present checkpoint for: ${task}.",
      },
    } as unknown as ResolvedFlow;
  }

  it("skips checkpoint state when evaluateSkipWhen returns skip: true", async () => {
    // Mock evaluateSkipWhen to simulate auto_approved condition met
    vi.mocked(evaluateSkipWhen).mockResolvedValue({
      skip: true,
      reason: "Task auto-approved — checkpoint skipped",
    });

    const workspace = makeTmpDir();
    const board = makeBoard({
      entry: "checkpoint",
      current_state: "checkpoint",
      states: {
        checkpoint: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
      metadata: { auto_approve: true },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(board);

    const flow = makeCheckpointFlow();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "checkpoint",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.can_enter).toBe(true);
    expect(result.skip_reason).toBeDefined();
    expect(result.skip_reason).toContain("auto_approved");
    // enterState should NOT be called — state is skipped before entering
    expect(enterState).not.toHaveBeenCalled();
  });

  it("does not skip checkpoint state when evaluateSkipWhen returns skip: false", async () => {
    // Mock evaluateSkipWhen to simulate no skip
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    const board = makeBoard({
      entry: "checkpoint",
      current_state: "checkpoint",
      states: {
        checkpoint: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
      metadata: { auto_approve: false },
    });
    const enteredBoard = makeBoard({
      entry: "checkpoint",
      current_state: "checkpoint",
      states: {
        checkpoint: { status: "in_progress", entries: 1 },
        done: { status: "pending", entries: 0 },
      },
      metadata: { auto_approve: false },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);

    const flow = makeCheckpointFlow();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "checkpoint",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.can_enter).toBe(true);
    expect(result.skip_reason).toBeUndefined();
    // State was entered normally
    expect(enterState).toHaveBeenCalled();
  });

  it("evaluateSkipWhen is called with the auto_approved condition when state has skip_when: auto_approved", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    const board = makeBoard({
      entry: "checkpoint",
      current_state: "checkpoint",
      states: {
        checkpoint: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    });
    const enteredBoard = makeBoard({
      entry: "checkpoint",
      current_state: "checkpoint",
      states: {
        checkpoint: { status: "in_progress", entries: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);

    const flow = makeCheckpointFlow();
    await enterAndPrepareState({
      workspace,
      state_id: "checkpoint",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
    });

    expect(evaluateSkipWhen).toHaveBeenCalledWith(
      "auto_approved",
      workspace,
      board,
    );
  });
});

// ===========================================================================
// 5. CROSS-FEATURE INTEGRATION — min_waves filtering + scoped re-review
//    A re-entered state that has consultation fragments with min_waves.
//    Verifies: git diff IS called AND min_waves filtering still applies.
// ===========================================================================

describe("cross-feature: min_waves filtering + scoped re-review in the same flow", () => {
  /**
   * A flow that has:
   * - A "implement" wave state that can be re-entered (entries > 1 triggers review_scope)
   * - A "between" consultation with min_waves: 2
   *
   * On re-entry with wave_total = 1: git diff called, consultation skipped.
   * On re-entry with wave_total = 2: git diff called, consultation included.
   */
  function makeFlowWithBothFeatures(): ResolvedFlow {
    return {
      name: "test-flow",
      description: "Test flow exercising both optimizations",
      entry: "implement",
      states: {
        implement: {
          type: "wave",
          agent: "canon-implementor",
          consultations: {
            between: ["pattern-check"],
          },
        },
        done: { type: "terminal" },
      },
      spawn_instructions: {
        implement: "Implement ${task}.",
        "pattern-check": "Check patterns.",
      },
      consultations: {
        "pattern-check": {
          fragment: "pattern-check",
          agent: "canon:canon-architect",
          role: "pattern-check",
          timeout: "5m",
          min_waves: 2,
        },
      },
    } as unknown as ResolvedFlow;
  }

  it("skips consultation (wave_total=1 < min_waves=2) AND calls git diff on re-entry", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    // entries=2 → re-entry triggers review_scope computation
    // wave_total=1 → min_waves:2 consultation should be skipped
    const board = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "done", entries: 1, wave_total: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    const enteredBoard = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "in_progress", entries: 2, wave_total: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);

    // git diff returns some files
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "src/foo.ts\nsrc/bar.ts\n",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
      wave: 1, // between breakpoint
    });

    expect(result.can_enter).toBe(true);

    // git diff SHOULD have been called (re-entry, entries=2)
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "abc1234..HEAD"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );

    // Consultation SHOULD be skipped (wave_total=1 < min_waves=2)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeUndefined();
  });

  it("includes consultation (wave_total=2 >= min_waves=2) AND calls git diff on re-entry", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    const board = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "done", entries: 1, wave_total: 2 },
        done: { status: "pending", entries: 0 },
      },
    });
    const enteredBoard = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "in_progress", entries: 2, wave_total: 2 },
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "src/changed.ts\n",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
      wave: 1, // between breakpoint
    });

    expect(result.can_enter).toBe(true);

    // git diff SHOULD have been called (re-entry, entries=2)
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "abc1234..HEAD"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );

    // Consultation SHOULD be included (wave_total=2 >= min_waves=2)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
    expect(patternCheck?.agent).toBe("canon:canon-architect");
  });

  it("both features degrade gracefully: git diff fails AND wave_total undefined (fail-open)", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    const board = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "done", entries: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    // entries=2 but wave_total not set → fail-open for min_waves (include consultation)
    const enteredBoard = makeBoard({
      base_commit: "abc1234",
      entry: "implement",
      current_state: "implement",
      states: {
        implement: { status: "in_progress", entries: 2 },
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);

    // git diff fails — review_scope degrades to empty
    vi.mocked(spawnSync).mockReturnValue({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      pid: 1,
      output: [],
      signal: null,
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test-task", CANON_PLUGIN_ROOT: "" },
      wave: 1,
    });

    // Should still succeed overall
    expect(result.can_enter).toBe(true);

    // Consultation SHOULD be included (wave_total undefined → fail-open → do NOT skip)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });
});
