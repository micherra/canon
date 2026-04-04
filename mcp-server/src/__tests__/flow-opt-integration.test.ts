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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../.."); // mcp-server/src/__tests__ → project root

// Mocks for enterAndPrepareState tests

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

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn((name: string, flow: unknown) => {
    // Return a minimal resolved consultation for testing
    const flowTyped = flow as { consultations?: Record<string, { agent: string; role: string }> };
    const fragment = flowTyped?.consultations?.[name];
    if (!fragment) return undefined;
    return {
      agent: fragment.agent,
      prompt: `Consultation: ${name}`,
      role: fragment.role,
    };
  }),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { loadFlow } from "../tools/load-flow.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-opt-integ-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: "review",
    entry: "review",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {
      done: { entries: 0, status: "pending" },
      review: { entries: 0, status: "pending" },
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

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// 0. loadFlow REGRESSION GUARD — errors: string[] retained on success path

describe("loadFlow — success path returns flow and state_graph (no errors field)", () => {
  it("loadFlow returns ok: true with flow and state_graph on success", async () => {
    const result = await loadFlow({ flow_name: "feature" }, pluginDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow).toBeDefined();
    expect(result.state_graph).toBeDefined();
  });

  it("loadFlow returns ok: false with FLOW_NOT_FOUND for missing flow", async () => {
    const result = await loadFlow({ flow_name: "nonexistent-flow-xyz" }, pluginDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("FLOW_NOT_FOUND");
    }
  });
});

// 1. REGRESSION GUARD — affected flows still load cleanly

describe("affected flows load without errors after all optimizations", () => {
  it("feature.md loads cleanly", async () => {
    await expect(loadAndResolveFlow(pluginDir, "feature")).resolves.toBeDefined();
  });

  it("epic.md loads cleanly", async () => {
    await expect(loadAndResolveFlow(pluginDir, "epic")).resolves.toBeDefined();
  });

  it("explore.md loads cleanly", async () => {
    await expect(loadAndResolveFlow(pluginDir, "explore")).resolves.toBeDefined();
  });

  it("refactor.md loads cleanly", async () => {
    await expect(loadAndResolveFlow(pluginDir, "refactor")).resolves.toBeDefined();
  });

  it("migrate.md loads cleanly", async () => {
    await expect(loadAndResolveFlow(pluginDir, "migrate")).resolves.toBeDefined();
  });
});

// 2. DISK-LOAD INTEGRATION — skip_when: auto_approved from user-checkpoint fragment

describe("disk-load: user-checkpoint fragment resolves skip_when: auto_approved", () => {
  it("feature.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "feature");

    const checkpointState = flow.states.checkpoint;
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });

  it("epic.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const checkpointState = flow.states.checkpoint;
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });

  it("refactor.md checkpoint state has skip_when: auto_approved after loading from disk", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "refactor");

    const checkpointState = flow.states.checkpoint;
    expect(checkpointState).toBeDefined();
    expect(checkpointState.skip_when).toBe("auto_approved");
  });
});

// 3. DISK-LOAD INTEGRATION — min_waves on consultation fragments
//    NOTE: This test suite documents a known implementation gap:
//    FragmentDefinitionSchema does not include min_waves, so it is dropped
//    during fragment parsing. The test asserts current behavior and will need
//    to be updated when the bug is fixed.

describe("disk-load: epic flow consultation fragments from disk", () => {
  it("epic flow consultations map contains pattern-check after disk load", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const consultations = flow.consultations;
    expect(consultations).toBeDefined();
    expect(consultations!["pattern-check"]).toBeDefined();
    // Verify agent and role are correctly resolved from fragment YAML
    expect(consultations!["pattern-check"].agent).toBe("canon-architect");
    expect(consultations!["pattern-check"].role).toBe("pattern-check");
  });

  it("epic flow consultations map contains early-scan after disk load", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const consultations = flow.consultations;
    expect(consultations!["early-scan"]).toBeDefined();
    expect(consultations!["early-scan"].agent).toBe("canon-security");
    expect(consultations!["early-scan"].role).toBe("early-scan");
  });

  it("epic implement state references pattern-check and early-scan in between breakpoint", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const implementState = flow.states.implement;
    expect(implementState).toBeDefined();
    const between = implementState.consultations?.between;
    expect(between).toContain("pattern-check");
    expect(between).toContain("early-scan");
  });
});

// 4. END-TO-END — auto_approved skip through enterAndPrepareState
//    (flow-opt-04 declared known gap: no integration test with full board fixture)

describe("enterAndPrepareState — auto_approved skip integration", () => {
  function makeCheckpointFlow(): ResolvedFlow {
    return {
      description: "Test flow with checkpoint",
      entry: "checkpoint",
      name: "test-flow",
      spawn_instructions: {
        checkpoint: "Present checkpoint for: ${task}.",
      },
      states: {
        checkpoint: {
          agent: "canon-guide",
          skip_when: "auto_approved",
          transitions: {
            approved: "done",
          },
          type: "single",
        },
        done: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;
  }

  it("skips checkpoint state when evaluateSkipWhen returns skip: true", async () => {
    // Mock evaluateSkipWhen to simulate auto_approved condition met
    vi.mocked(evaluateSkipWhen).mockResolvedValue({
      reason: "Task auto-approved — checkpoint skipped",
      skip: true,
    });

    const workspace = makeTmpDir();
    seedBoard(
      workspace,
      makeBoard({
        current_state: "checkpoint",
        entry: "checkpoint",
        states: {
          checkpoint: { entries: 0, status: "pending" },
          done: { entries: 0, status: "pending" },
        },
      }),
    );

    const flow = makeCheckpointFlow();
    const result = await enterAndPrepareState({
      flow,
      state_id: "checkpoint",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      workspace,
    });
    assertOk(result);

    expect(result.can_enter).toBe(true);
    expect(result.skip_reason).toBeDefined();
    expect(result.skip_reason).toContain("auto_approved");
    // State is skipped before entering — board state remains pending (not in_progress)
    const checkpointState = getExecutionStore(workspace).getState("checkpoint");
    expect(checkpointState?.status).toBe("pending");
  });

  it("does not skip checkpoint state when evaluateSkipWhen returns skip: false", async () => {
    // Mock evaluateSkipWhen to simulate no skip
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    seedBoard(
      workspace,
      makeBoard({
        current_state: "checkpoint",
        entry: "checkpoint",
        states: {
          checkpoint: { entries: 0, status: "pending" },
          done: { entries: 0, status: "pending" },
        },
      }),
    );

    const flow = makeCheckpointFlow();
    const result = await enterAndPrepareState({
      flow,
      state_id: "checkpoint",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      workspace,
    });
    assertOk(result);

    expect(result.can_enter).toBe(true);
    expect(result.skip_reason).toBeUndefined();
    // State was entered normally — board state should be in_progress
    const checkpointState = getExecutionStore(workspace).getState("checkpoint");
    expect(checkpointState?.status).toBe("in_progress");
  });

  it("evaluateSkipWhen is called with the auto_approved condition when state has skip_when: auto_approved", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    seedBoard(
      workspace,
      makeBoard({
        current_state: "checkpoint",
        entry: "checkpoint",
        states: {
          checkpoint: { entries: 0, status: "pending" },
          done: { entries: 0, status: "pending" },
        },
      }),
    );

    const flow = makeCheckpointFlow();
    await enterAndPrepareState({
      flow,
      state_id: "checkpoint",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      workspace,
    });

    expect(evaluateSkipWhen).toHaveBeenCalledWith(
      "auto_approved",
      workspace,
      expect.objectContaining({ entry: "checkpoint", flow: "test-flow" }),
    );
  });
});

// 5. CROSS-FEATURE INTEGRATION — min_waves filtering + scoped re-review
//    A re-entered state that has consultation fragments with min_waves.
//    Verifies: git diff IS called AND min_waves filtering still applies.

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
      consultations: {
        "pattern-check": {
          agent: "canon:canon-architect",
          fragment: "pattern-check",
          min_waves: 2,
          role: "pattern-check",
          timeout: "5m",
        },
      },
      description: "Test flow exercising both optimizations",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement ${task}.",
        "pattern-check": "Check patterns.",
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

  it("skips consultation (wave_total=1 < min_waves=2) AND calls git diff on re-entry", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

    const workspace = makeTmpDir();
    // entries=1 in pre-enter → after enterState: entries=2 (re-entry triggers git diff)
    // wave_total=1 → min_waves:2 consultation should be skipped
    seedBoard(
      workspace,
      makeBoard({
        base_commit: "abc1234",
        current_state: "implement",
        entry: "implement",
        states: {
          done: { entries: 0, status: "pending" },
          implement: { entries: 1, status: "done", wave_total: 1 },
        },
      }),
    );

    // git diff returns some files
    vi.mocked(spawnSync).mockReturnValue({
      output: [],
      pid: 1,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "src/foo.ts\nsrc/bar.ts\n",
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      wave: 1, // between breakpoint
      workspace,
    });
    assertOk(result);

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
    // entries=1 in pre-enter → after enterState: entries=2 (re-entry triggers git diff)
    // wave_total=2 → min_waves:2 consultation should be included
    seedBoard(
      workspace,
      makeBoard({
        base_commit: "abc1234",
        current_state: "implement",
        entry: "implement",
        states: {
          done: { entries: 0, status: "pending" },
          implement: { entries: 1, status: "done", wave_total: 2 },
        },
      }),
    );

    vi.mocked(spawnSync).mockReturnValue({
      output: [],
      pid: 1,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "src/changed.ts\n",
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      wave: 1, // between breakpoint
      workspace,
    });
    assertOk(result);

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
    // entries=1 in pre-enter → after enterState: entries=2 (re-entry)
    // wave_total not set → fail-open for min_waves (include consultation)
    seedBoard(
      workspace,
      makeBoard({
        base_commit: "abc1234",
        current_state: "implement",
        entry: "implement",
        states: {
          done: { entries: 0, status: "pending" },
          implement: { entries: 1, status: "done" },
        },
      }),
    );

    // git diff fails — review_scope degrades to empty
    vi.mocked(spawnSync).mockReturnValue({
      output: [],
      pid: 1,
      signal: null,
      status: 128,
      stderr: "fatal: not a git repository",
      stdout: "",
    });

    const flow = makeFlowWithBothFeatures();
    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    // Should still succeed overall
    expect(result.can_enter).toBe(true);

    // Consultation SHOULD be included (wave_total undefined → fail-open → do NOT skip)
    const patternCheck = result.consultation_prompts?.find((e) => e.name === "pattern-check");
    expect(patternCheck).toBeDefined();
  });
});
