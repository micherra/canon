/**
 * Tests for conditional consultations -- min_waves filtering.
 *
 * These tests verify:
 * 1. ConsultationFragmentSchema accepts optional min_waves field
 * 2. enterAndPrepareState skips consultations when wave_total < min_waves
 * 3. enterAndPrepareState includes consultations when wave_total >= min_waves
 * 4. Consultations without min_waves always fire regardless of wave_total
 * 5. Fail-open: when wave_total is undefined, consultation fires normally
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.js", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
  enterState: vi.fn(),
}));

vi.mock("../orchestration/workspace.js", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/skip-when.js", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.js", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.js", () => ({
  createJsonlLogger: vi.fn(() => vi.fn()),
}));

vi.mock("../orchestration/wave-briefing.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../orchestration/wave-briefing.js")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

import { readBoard, enterState } from "../orchestration/board.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { ConsultationFragmentSchema } from "../orchestration/flow-schema.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cond-consult-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      implement: { status: "pending", entries: 0 },
      done: { status: "pending", entries: 0 },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

/**
 * A flow with a "between" consultation that has min_waves: 2.
 * This consultation should only fire when wave_total >= 2.
 */
function makeFlowWithMinWavesConsultation(minWaves: number = 2): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
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
      implement: "Implement ${task} for ${item}.",
      "pattern-check": "Check patterns for ${task}.",
    },
    consultations: {
      "pattern-check": {
        fragment: "pattern-check",
        agent: "canon:canon-architect",
        role: "pattern-check",
        timeout: "5m",
        min_waves: minWaves,
      },
    },
  } as unknown as ResolvedFlow;
}

/**
 * A flow with a "between" consultation that has NO min_waves.
 * This consultation should always fire.
 */
function makeFlowWithUnconditionalConsultation(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "wave",
        agent: "canon-implementor",
        consultations: {
          between: ["plan-review"],
        },
      },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "plan-review": "Review the plan for ${task}.",
    },
    consultations: {
      "plan-review": {
        fragment: "plan-review",
        agent: "canon:canon-architect",
        role: "plan-reviewer",
      },
    },
  } as unknown as ResolvedFlow;
}

/**
 * A flow with a "before" consultation that has min_waves: 2.
 * The min_waves check applies to before/between/after -- it is on the fragment,
 * not breakpoint-specific.
 */
function makeFlowWithMinWavesBeforeConsultation(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "wave",
        agent: "canon-implementor",
        consultations: {
          before: ["early-scan"],
        },
      },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "early-scan": "Quick scan for ${task}.",
    },
    consultations: {
      "early-scan": {
        fragment: "early-scan",
        agent: "canon:canon-security",
        role: "early-scan",
        timeout: "5m",
        min_waves: 2,
      },
    },
  } as unknown as ResolvedFlow;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Schema tests
// ---------------------------------------------------------------------------

describe("ConsultationFragmentSchema — min_waves field", () => {
  it("accepts a fragment with min_waves field", () => {
    const result = ConsultationFragmentSchema.safeParse({
      fragment: "pattern-check",
      agent: "canon:canon-architect",
      role: "pattern-check",
      timeout: "5m",
      min_waves: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_waves).toBe(2);
    }
  });

  it("accepts a fragment without min_waves (backward compat)", () => {
    const result = ConsultationFragmentSchema.safeParse({
      fragment: "plan-review",
      agent: "canon:canon-architect",
      role: "plan-reviewer",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_waves).toBeUndefined();
    }
  });

  it("rejects a fragment with non-numeric min_waves", () => {
    const result = ConsultationFragmentSchema.safeParse({
      fragment: "test",
      agent: "canon:canon-architect",
      role: "test",
      min_waves: "two",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Runtime filtering tests -- between consultations
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — min_waves filtering for between consultations", () => {
  function setupMocks(waveTotalOverride?: number) {
    const board = makeBoard();
    // wave_total set on the state entry to simulate board state
    const stateEntry: Record<string, unknown> = { status: "in_progress", entries: 1 };
    if (waveTotalOverride !== undefined) {
      stateEntry.wave_total = waveTotalOverride;
    }
    const enteredBoard = makeBoard({
      states: {
        implement: stateEntry,
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);
  }

  it("skips between consultation with min_waves:2 when wave_total is 1", async () => {
    setupMocks(1);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 1, // wave >= 1 triggers "between" breakpoint
    });

    // Should be skipped: wave_total (1) < min_waves (2)
    const patternCheck = result.consultation_prompts?.find(e => e.name === "pattern-check");
    expect(patternCheck).toBeUndefined();
  });

  it("includes between consultation with min_waves:2 when wave_total is 2", async () => {
    setupMocks(2);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 1, // wave >= 1 triggers "between" breakpoint
    });

    // Should be included: wave_total (2) >= min_waves (2)
    const patternCheck = result.consultation_prompts?.find(e => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
    expect(patternCheck?.name).toBe("pattern-check");
  });

  it("includes between consultation with min_waves:2 when wave_total is 3", async () => {
    setupMocks(3);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 2,
    });

    const patternCheck = result.consultation_prompts?.find(e => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });

  it("includes between consultation when wave_total is undefined (fail-open)", async () => {
    // wave_total NOT set on board state -- should fail-open and include the consultation
    setupMocks(undefined);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 1,
    });

    // Fail-open: wave_total undefined → do NOT skip
    const patternCheck = result.consultation_prompts?.find(e => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });

  it("always includes between consultation without min_waves regardless of wave_total", async () => {
    setupMocks(1);
    const workspace = makeTmpDir();
    const flow = makeFlowWithUnconditionalConsultation();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 1,
    });

    const planReview = result.consultation_prompts?.find(e => e.name === "plan-review");
    expect(planReview).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime filtering tests -- before consultations with min_waves
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — min_waves filtering for before consultations", () => {
  function setupMocks(waveTotalOverride?: number) {
    const board = makeBoard();
    const stateEntry: Record<string, unknown> = { status: "in_progress", entries: 1 };
    if (waveTotalOverride !== undefined) {
      stateEntry.wave_total = waveTotalOverride;
    }
    const enteredBoard = makeBoard({
      states: {
        implement: stateEntry,
        done: { status: "pending", entries: 0 },
      },
    });
    vi.mocked(readBoard).mockResolvedValue(board);
    vi.mocked(enterState).mockReturnValue(enteredBoard);
  }

  it("skips before consultation with min_waves:2 when wave_total is 1", async () => {
    setupMocks(1);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesBeforeConsultation();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 0, // wave 0 triggers "before" breakpoint
    });

    const earlyScan = result.consultation_prompts?.find(e => e.name === "early-scan");
    expect(earlyScan).toBeUndefined();
  });

  it("includes before consultation with min_waves:2 when wave_total is 2", async () => {
    setupMocks(2);
    const workspace = makeTmpDir();
    const flow = makeFlowWithMinWavesBeforeConsultation();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      wave: 0,
    });

    const earlyScan = result.consultation_prompts?.find(e => e.name === "early-scan");
    expect(earlyScan).toBeDefined();
  });
});
