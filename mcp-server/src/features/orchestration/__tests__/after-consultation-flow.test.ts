/**
 * Integration tests for the "after" consultation breakpoint feature — flow and coexistence.
 *
 * Split from after-consultation-integration.test.ts. Covers:
 * - Cross-task: resolveAfterConsultations output shape consumed by enterAndPrepareState
 * - After-consultation summary stored on board flows into subsequent enterAndPrepareState briefing
 * - resolveAfterConsultations → ConsultationPromptEntry shape contract
 * - All three breakpoints (before/between/after) coexist correctly in briefing collection
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

// Leave assembleWaveBriefing real — we test actual briefing output.
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
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "after-flow-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

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
      review: { entries: 0, status: "pending" },
    },
    task: "test task",
    ...overrides,
  } as Board;
}

/**
 * Seeds the ExecutionStore with the given board data so that
 * enterAndPrepareState (which reads from the store) can find it.
 */
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
  for (const [stateId, iterEntry] of Object.entries(board.iterations ?? {})) {
    store.upsertIteration(stateId, {
      cannot_fix: iterEntry.cannot_fix ?? [],
      count: iterEntry.count,
      history: iterEntry.history ?? [],
      max: iterEntry.max,
    });
  }
}

/**
 * A flow where the "implement" state has an "after" consultation
 * and the "review" state has a "before" consultation using the same
 * fragment.
 */
function makeFlowWithAfterAndNextState(): ResolvedFlow {
  return {
    consultations: {
      "post-impl-check": {
        agent: "canon:security",
        fragment: "post-impl-check",
        role: "security-reviewer",
        section: "Post-Implementation Check",
      },
    },
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${task}.",
      "post-impl-check": "Run post-implementation check for ${task}.",
      review: "Review ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "implementor",
        consultations: {
          after: ["post-impl-check"],
        },
        type: "wave",
      },
      review: {
        agent: "reviewer",
        consultations: {
          before: ["post-impl-check"],
        },
        type: "single",
      },
    },
  } as unknown as ResolvedFlow;
}

// Cross-task integration: resolveAfterConsultations → board storage →
// enterAndPrepareState in next state picks up the summary
//
// This tests the full lifecycle that spans after-01 (tool) and after-02
// (briefing fix): orchestrator calls resolveAfterConsultations, spawns agents,
// records summaries on the board under consultations.after, then the NEXT
// STATE's enterAndPrepareState picks them up via the briefing injection pipeline.

describe("cross-task: resolveAfterConsultations → board → same state next wave briefing injection", () => {
  it("after-consultation summary stored on board flows into same state's next wave briefing", async () => {
    const workspace = makeTmpDir();

    // Step 1: Call resolveAfterConsultations for "implement" state after wave 0
    const flow = makeFlowWithAfterAndNextState();
    const afterResult = resolveAfterConsultations({
      flow,
      state_id: "implement",
      variables: { task: "cross-task-feature" },
      workspace,
    });

    // Verify the tool returned a valid prompt entry
    expect(afterResult.warnings).toHaveLength(0);
    expect(afterResult.consultation_prompts).toHaveLength(1);
    expect(afterResult.consultation_prompts[0].name).toBe("post-impl-check");

    // Step 2: Simulate orchestrator recording the result on the board under
    // implement.wave_results["after"].consultations.after.
    // The briefing injection in enterAndPrepareState reads board.states[state_id].wave_results,
    // so the after-summary must live on the implement state's wave_results.
    const boardWithAfterSummary = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: {
          entries: 1,
          status: "in_progress",
          wave_results: {
            after: {
              consultations: {
                after: {
                  "post-impl-check": {
                    status: "done",
                    summary: "All security checks passed. Parameterized queries used throughout.",
                  },
                },
              },
              status: "done",
              tasks: [],
            },
          },
        },
        review: { entries: 0, status: "pending" },
      },
    });

    seedBoard(workspace, boardWithAfterSummary);

    // Step 3: enterAndPrepareState for WAVE 1 of the SAME "implement" state reads
    // board.states["implement"].wave_results and picks up the after-consultation summary
    // via the briefing injection scan (which includes "after" breakpoint per after-02).
    const wave1Result = await enterAndPrepareState({
      flow,
      items: ["task-b"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "cross-task-feature" },
      wave: 1,
      workspace,
    });

    assertOk(wave1Result);
    expect(wave1Result.can_enter).toBe(true);
    expect(wave1Result.prompts).toHaveLength(1);

    // The "after" consultation summary from wave_results must appear
    // in wave 1's prompt briefing
    const prompt = wave1Result.prompts[0].prompt;
    expect(prompt).toContain("Post-Implementation Check");
    expect(prompt).toContain("All security checks passed.");
  });

  it("after-consultation prompt entry produced by resolveAfterConsultations has correct structure for orchestrator spawn", () => {
    const flow = makeFlowWithAfterAndNextState();
    const afterResult = resolveAfterConsultations({
      flow,
      state_id: "implement",
      variables: { task: "cross-task-feature" },
      workspace: "/tmp/ws",
    });

    // Orchestrator reads these fields to spawn the consultation agent
    expect(afterResult.consultation_prompts).toHaveLength(1);
    const entry = afterResult.consultation_prompts[0];

    // All fields the orchestrator needs to spawn an agent
    expect(entry.name).toBe("post-impl-check");
    expect(entry.agent).toBe("canon:security");
    expect(entry.role).toBe("security-reviewer");
    expect(entry.prompt).toContain("cross-task-feature");
    expect(entry.section).toBe("Post-Implementation Check");
    // No timeout on this fragment
    expect("timeout" in entry).toBe(false);
  });
});

// Cross-task: resolveAfterConsultations output shape matches what
// enterAndPrepareState expects when constructing ConsultationPromptEntry
//
// after-01 produces entries; the orchestrator must be able to spawn agents
// using them. Verify the output type contract is complete.

describe("resolveAfterConsultations → ConsultationPromptEntry shape contract", () => {
  it("output entry has all required ConsultationPromptEntry fields", () => {
    const flow: ResolvedFlow = {
      consultations: {
        "final-audit": {
          agent: "canon:security",
          fragment: "final-audit",
          role: "security",
          section: "Final Audit",
          timeout: "10m",
        },
      },
      description: "Test",
      entry: "review",
      name: "test-flow",
      spawn_instructions: {
        "final-audit": "Audit ${component} after implementation.",
      },
      states: {
        review: {
          agent: "reviewer",
          consultations: { after: ["final-audit"] },
          type: "single",
        },
      },
    } as unknown as ResolvedFlow;

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: { component: "auth-module" },
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(1);
    const entry = result.consultation_prompts[0];

    // Required fields from ConsultationPromptEntry interface
    expect(entry).toHaveProperty("name", "final-audit");
    expect(entry).toHaveProperty("agent", "canon:security");
    expect(entry).toHaveProperty("role", "security");
    expect(entry).toHaveProperty("prompt");
    expect(typeof entry.prompt).toBe("string");
    expect(entry.prompt.length).toBeGreaterThan(0);

    // Optional fields forwarded when present
    expect(entry).toHaveProperty("timeout", "10m");
    expect(entry).toHaveProperty("section", "Final Audit");

    // Variable substitution verified
    expect(entry.prompt).toContain("auth-module");
    expect(entry.prompt).not.toContain("${component}");
  });

  it("multiple after entries returned in declaration order", () => {
    const flow: ResolvedFlow = {
      consultations: {
        "check-a": { agent: "canon:agent-a", fragment: "check-a", role: "role-a" },
        "check-b": { agent: "canon:agent-b", fragment: "check-b", role: "role-b" },
        "check-c": { agent: "canon:agent-c", fragment: "check-c", role: "role-c" },
      },
      description: "Test",
      entry: "review",
      name: "test-flow",
      spawn_instructions: {
        "check-a": "Check A for ${task}.",
        "check-b": "Check B for ${task}.",
        "check-c": "Check C for ${task}.",
      },
      states: {
        review: {
          agent: "reviewer",
          consultations: { after: ["check-a", "check-b", "check-c"] },
          type: "single",
        },
      },
    } as unknown as ResolvedFlow;

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: { task: "order-test" },
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(3);
    expect(result.consultation_prompts[0].name).toBe("check-a");
    expect(result.consultation_prompts[1].name).toBe("check-b");
    expect(result.consultation_prompts[2].name).toBe("check-c");
    expect(result.warnings).toHaveLength(0);
  });
});

// Cross-task: "after" and "before"/"between" summaries coexist correctly
//
// Ensures the after-02 fix does not disrupt existing "before"/"between"
// collection — all three breakpoints are collected simultaneously.

describe("enterAndPrepareState — all three breakpoints coexist in briefing collection", () => {
  it("before, between, and after summaries are all collected and injected into briefing", async () => {
    const workspace = makeTmpDir();

    const boardWithAllBreakpoints = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: {
          entries: 2,
          status: "in_progress",
          wave_results: {
            "wave-0": {
              consultations: {
                after: {
                  "post-check": {
                    status: "done",
                    summary: "Post-check: wave completed successfully.",
                  },
                },
                before: {
                  "pre-check": {
                    status: "done",
                    summary: "Pre-check: all preconditions met.",
                  },
                },
                between: {
                  "mid-check": {
                    status: "done",
                    summary: "Mid-check: progress looks good.",
                  },
                },
              },
              status: "done",
              tasks: ["task-a"],
            },
          },
        },
      },
    });

    seedBoard(workspace, boardWithAllBreakpoints);

    // IMPORTANT: The state definition MUST have a consultations key for the
    // collection block in enterAndPrepareState to be entered (line 171:
    // `if (stateDef?.consultations)`). Without it the whole collection is skipped.
    const flow: ResolvedFlow = {
      consultations: {
        "mid-check": {
          agent: "canon:researcher",
          fragment: "mid-check",
          role: "researcher",
          section: "Mid-Check",
        },
        "post-check": {
          agent: "canon:security",
          fragment: "post-check",
          role: "security",
          section: "Post-Check",
        },
        "pre-check": {
          agent: "canon:security",
          fragment: "pre-check",
          role: "security",
          section: "Pre-Check",
        },
      },
      description: "Test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement ${task}.",
      },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "implementor",
          // Declare an empty between array — this makes stateDef.consultations truthy
          // so the collection block runs and collects prior wave summaries.
          consultations: {
            between: [],
          },
          type: "wave",
        },
      },
    } as unknown as ResolvedFlow;

    const result = await enterAndPrepareState({
      flow,
      items: ["task-a"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "all-breakpoints-test" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.prompts).toHaveLength(1);
    const prompt = result.prompts[0].prompt;

    // All three breakpoints' summaries appear in the briefing
    expect(prompt).toContain("Pre-Check");
    expect(prompt).toContain("Pre-check: all preconditions met.");
    expect(prompt).toContain("Mid-Check");
    expect(prompt).toContain("Mid-check: progress looks good.");
    expect(prompt).toContain("Post-Check");
    expect(prompt).toContain("Post-check: wave completed successfully.");
  });
});
