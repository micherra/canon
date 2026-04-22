/**
 * Integration tests for the consultation pipeline wiring (Part 1).
 *
 * These tests cover:
 * 1. End-to-end path: resolveConsultationPrompt output shape → enterAndPrepareState contract
 * 2. Known Gap (wcpl-01): fragment with both timeout AND section simultaneously
 * 3. Known Gap (wcpl-03): multiple consultations in one breakpoint (loop path)
 * 4. Known Gap (wcpl-02): wave=null with consultation_outputs present (guard holds)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/flows/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("@domains/messages/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

// wave-briefing: mock readWaveGuidance to return empty (no wave guidance file)
// but leave assembleWaveBriefing REAL so we test the actual briefing output.
vi.mock("../services/wave-briefing.ts", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@features/orchestration/services/wave-briefing.ts")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { resolveConsultationPrompt } from "../engine/consultation-executor.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-int-"));
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
 * A flow with a wave state that has a single "before" consultation declared.
 */
function makeFlowWithBeforeConsultation(): ResolvedFlow {
  return {
    consultations: {
      "security-review": {
        agent: "canon:security",
        fragment: "security-review",
        role: "security-reviewer",
        section: "Security Review",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "security-review": "Review security for ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "implementor",
        consultations: {
          before: ["security-review"],
        },
        type: "wave",
      },
    },
  } as unknown as ResolvedFlow;
}

/**
 * A flow with two consultations in the same breakpoint.
 */
function makeFlowWithMultipleConsultations(): ResolvedFlow {
  return {
    consultations: {
      "perf-review": {
        agent: "canon:researcher",
        fragment: "perf-review",
        role: "researcher",
      },
      "security-review": {
        agent: "canon:security",
        fragment: "security-review",
        role: "security-reviewer",
        section: "Security Review",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${task} for ${item}.",
      "perf-review": "Check performance for ${task}.",
      "security-review": "Review security for ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "implementor",
        consultations: {
          before: ["security-review", "perf-review"],
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

// 1. resolveConsultationPrompt output shape → enterAndPrepareState contract
//
// wcpl-01 produces { agent, prompt, role, timeout?, section? }
// wcpl-03 must pass all five fields through into consultation_prompts entries

describe("resolveConsultationPrompt → enterAndPrepareState: output shape contract", () => {
  it("passes timeout and section from resolveConsultationPrompt into consultation_prompts entry", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    const flow = makeFlowWithBeforeConsultation();

    // Use real resolveConsultationPrompt — this tests wcpl-01 output feeding wcpl-03
    const resolved = resolveConsultationPrompt("security-review", flow, { task: "my-task" });
    expect(resolved).not.toBeNull();
    expect(resolved!.timeout).toBe("5m");
    expect(resolved!.section).toBe("Security Review");

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeDefined();
    expect(result.consultation_prompts).toHaveLength(1);

    const entry = result.consultation_prompts![0];
    expect(entry.name).toBe("security-review");
    expect(entry.agent).toBe("canon:security");
    expect(entry.role).toBe("security-reviewer");
    expect(entry.timeout).toBe("5m");
    expect(entry.section).toBe("Security Review");
  });

  it("omits timeout and section keys entirely from consultation_prompts when fragment lacks them", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    const flow = makeFlowWithMultipleConsultations();

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeDefined();
    // perf-review has no timeout or section
    const perfEntry = result.consultation_prompts!.find((e) => e.name === "perf-review");
    expect(perfEntry).toBeDefined();
    expect("timeout" in perfEntry!).toBe(false);
    expect("section" in perfEntry!).toBe(false);
  });
});

// 2. Known Gap (wcpl-01): fragment with both timeout AND section simultaneously

describe("resolveConsultationPrompt — both timeout and section present", () => {
  it("returns both timeout and section when fragment declares them simultaneously", () => {
    const flow: ResolvedFlow = {
      consultations: {
        "full-check": {
          agent: "canon:security",
          fragment: "full-check",
          role: "security",
          section: "## Full Security Audit",
          timeout: "10m",
        },
      },
      description: "Test flow",
      entry: "start",
      name: "test-flow",
      spawn_instructions: { "full-check": "Run full check for ${task}." },
      states: { start: { type: "terminal" } },
    } as unknown as ResolvedFlow;

    const result = resolveConsultationPrompt("full-check", flow, { task: "my-feature" });

    expect(result).not.toBeNull();
    // Both fields present simultaneously — not one or the other
    expect(result!.timeout).toBe("10m");
    expect(result!.section).toBe("## Full Security Audit");
    // Core fields still present
    expect(result!.agent).toBe("canon:security");
    expect(result!.role).toBe("security");
    expect(result!.prompt).toBe("Run full check for my-feature.");
  });
});

// 3. Known Gap (wcpl-03): multiple consultations in one breakpoint

describe("enterAndPrepareState — multiple consultations in same breakpoint", () => {
  it("resolves all consultations in the breakpoint and returns them all in consultation_prompts", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    const flow = makeFlowWithMultipleConsultations();

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeDefined();
    expect(result.consultation_prompts).toHaveLength(2);

    const names = result.consultation_prompts!.map((e) => e.name);
    expect(names).toContain("security-review");
    expect(names).toContain("perf-review");
  });

  it("resolves each consultation independently — one missing does not block others", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    // Flow where second consultation has no spawn instruction
    const flow: ResolvedFlow = {
      consultations: {
        "security-review": {
          agent: "canon:security",
          fragment: "security-review",
          role: "security-reviewer",
        },
        // "missing-consult" is also absent from flow.consultations
      },
      description: "Test flow",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement ${task}.",
        "security-review": "Review security for ${task}.",
        // "missing-consult" spawn instruction is absent
      },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "implementor",
          consultations: {
            before: ["security-review", "missing-consult"],
          },
          type: "wave",
        },
      },
    } as unknown as ResolvedFlow;

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    // Only security-review resolves; missing-consult returns null and is skipped
    expect(result.consultation_prompts).toBeDefined();
    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts![0].name).toBe("security-review");
  });
});

// 4. Known Gap (wcpl-02): wave=null with consultation_outputs present
//    assembleWaveBriefing NOT called because wave is null

describe("getSpawnPrompt — wave=null with consultation_outputs does not inject briefing", () => {
  it("does not call assembleWaveBriefing when wave is null even if consultation_outputs provided", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());

    const flow: ResolvedFlow = {
      description: "Test flow",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "implementor", type: "wave" },
        done: { type: "terminal" },
      },
    };

    const result = await getSpawnPrompt({
      consultation_outputs: {
        security: { section: "Security", summary: "All clear." },
      },
      flow,
      items: ["task-a"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "" },
      wave: undefined, // wave is null/undefined — guard must block injection
      workspace,
    });

    // No wave → messaging/guidance/briefing injection blocks all fire on `input.wave != null`
    // The prompt should not contain any briefing content
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
    expect(result.prompts[0].prompt).not.toContain("All clear.");
  });
});
