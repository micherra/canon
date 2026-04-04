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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

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

vi.mock("../orchestration/wave-briefing.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../orchestration/wave-briefing.ts")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { ConsultationFragmentSchema } from "../orchestration/flow-schema.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cond-consult-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {
      done: { entries: 0, status: "pending" },
      implement: { entries: 0, status: "pending" },
    },
    task: "test task",
    ...overrides,
  } as Board;
}

function seedBoard(workspace: string, board: Board): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: board.base_commit,
    branch: "main",
    created: now,
    current_state: board.current_state,
    entry: board.entry,
    flow: board.flow,
    flow_name: board.flow,
    last_updated: board.last_updated ?? now,
    sanitized: "main",
    slug: "test-slug",
    started: board.started ?? now,
    task: board.task,
    tier: "medium",
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, {
      ...stateEntry,
      entries: stateEntry.entries ?? 0,
      status: stateEntry.status,
    });
  }
}

/**
 * A flow with a "between" consultation that has min_waves: 2.
 * This consultation should only fire when wave_total >= 2.
 */
function makeFlowWithMinWavesConsultation(minWaves: number = 2): ResolvedFlow {
  return {
    consultations: {
      "pattern-check": {
        agent: "canon:canon-architect",
        fragment: "pattern-check",
        min_waves: minWaves,
        role: "pattern-check",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "pattern-check": "Check patterns for ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "canon-implementor",
        consultations: {
          between: ["pattern-check"],
        },
        type: "wave",
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
    consultations: {
      "plan-review": {
        agent: "canon:canon-architect",
        fragment: "plan-review",
        role: "plan-reviewer",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "plan-review": "Review the plan for ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "canon-implementor",
        consultations: {
          between: ["plan-review"],
        },
        type: "wave",
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
    consultations: {
      "early-scan": {
        agent: "canon:canon-security",
        fragment: "early-scan",
        min_waves: 2,
        role: "early-scan",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      "early-scan": "Quick scan for ${task}.",
      implement: "Implement ${task} for ${item}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "canon-implementor",
        consultations: {
          before: ["early-scan"],
        },
        type: "wave",
      },
    },
  } as unknown as ResolvedFlow;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// 1. Schema tests

describe("ConsultationFragmentSchema — min_waves field", () => {
  it("accepts a fragment with min_waves field", () => {
    const result = ConsultationFragmentSchema.safeParse({
      agent: "canon:canon-architect",
      fragment: "pattern-check",
      min_waves: 2,
      role: "pattern-check",
      timeout: "5m",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_waves).toBe(2);
    }
  });

  it("accepts a fragment without min_waves (backward compat)", () => {
    const result = ConsultationFragmentSchema.safeParse({
      agent: "canon:canon-architect",
      fragment: "plan-review",
      role: "plan-reviewer",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_waves).toBeUndefined();
    }
  });

  it("rejects a fragment with non-numeric min_waves", () => {
    const result = ConsultationFragmentSchema.safeParse({
      agent: "canon:canon-architect",
      fragment: "test",
      min_waves: "two",
      role: "test",
    });
    expect(result.success).toBe(false);
  });
});

// 2. Runtime filtering tests -- between consultations

describe("enterAndPrepareState — min_waves filtering for between consultations", () => {
  function setupBoard(workspace: string, waveTotalOverride?: number) {
    // wave_total set on the state entry BEFORE entering so enterState preserves it
    const stateEntry: Record<string, unknown> = { entries: 0, status: "pending" };
    if (waveTotalOverride !== undefined) {
      stateEntry.wave_total = waveTotalOverride;
    }
    const board = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: stateEntry,
      },
    });
    seedBoard(workspace, board);
  }

  it("skips between consultation with min_waves:2 when wave_total is 1", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 1);
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1, // wave >= 1 triggers "between" breakpoint
      workspace,
    });
    assertOk(result);

    // Should be skipped: wave_total (1) < min_waves (2)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeUndefined();
  });

  it("includes between consultation with min_waves:2 when wave_total is 2", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 2);
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1, // wave >= 1 triggers "between" breakpoint
      workspace,
    });
    assertOk(result);

    // Should be included: wave_total (2) >= min_waves (2)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
    expect(patternCheck?.name).toBe("pattern-check");
  });

  it("includes between consultation with min_waves:2 when wave_total is 3", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 3);
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 2,
      workspace,
    });
    assertOk(result);

    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });

  it("includes between consultation when wave_total is undefined (fail-open)", async () => {
    // wave_total NOT set on board state -- should fail-open and include the consultation
    const workspace = makeTmpDir();
    setupBoard(workspace, undefined);
    const flow = makeFlowWithMinWavesConsultation(2);

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    // Fail-open: wave_total undefined → do NOT skip
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });

  it("always includes between consultation without min_waves regardless of wave_total", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 1);
    const flow = makeFlowWithUnconditionalConsultation();

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    const planReview = result.consultation_prompts?.find((e) => e.name === "plan-review");
    expect(planReview).toBeDefined();
  });
});

// 3. Runtime filtering tests -- before consultations with min_waves

describe("enterAndPrepareState — min_waves filtering for before consultations", () => {
  function setupBoard(workspace: string, waveTotalOverride?: number) {
    const stateEntry: Record<string, unknown> = { entries: 0, status: "pending" };
    if (waveTotalOverride !== undefined) {
      stateEntry.wave_total = waveTotalOverride;
    }
    const board = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: stateEntry,
      },
    });
    seedBoard(workspace, board);
  }

  it("skips before consultation with min_waves:2 when wave_total is 1", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 1);
    const flow = makeFlowWithMinWavesBeforeConsultation();

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0, // wave 0 triggers "before" breakpoint
      workspace,
    });
    assertOk(result);

    const earlyScan = result.consultation_prompts?.find((e) => e.name === "early-scan");
    expect(earlyScan).toBeUndefined();
  });

  it("includes before consultation with min_waves:2 when wave_total is 2", async () => {
    const workspace = makeTmpDir();
    setupBoard(workspace, 2);
    const flow = makeFlowWithMinWavesBeforeConsultation();

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    const earlyScan = result.consultation_prompts?.find((e) => e.name === "early-scan");
    expect(earlyScan).toBeDefined();
  });
});
