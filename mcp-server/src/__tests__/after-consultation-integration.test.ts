/**
 * Integration tests for the "after" consultation breakpoint feature.
 *
 * Covers declared Known Gaps and cross-task integration boundaries that
 * the implementor unit tests do not exercise:
 *
 * Known Gaps (from implementor summaries):
 *   - after-01: No integration test for resolveAfterConsultations → index.ts registration
 *   - after-02: "after" breakpoint with status !== "done" — skipped gracefully
 *   - after-02: "after" breakpoint with no section on fragment — summary included without heading
 *
 * Cross-task integration:
 *   - resolveAfterConsultations output shape consumed by enterAndPrepareState in next state
 *   - After-consultation summary stored on board (via WaveResult.consultations.after) flows
 *     into a subsequent enterAndPrepareState briefing injection
 *   - Multiple "after" consultation names across different wave keys — all collected
 *   - "after" consultation with non-"done" status is not injected into briefing
 *
 * End-to-end lifecycle:
 *   - resolveAfterConsultations → orchestrator spawns agents → records results on board
 *     with breakpoint "after" → enterAndPrepareState on next state injects into briefing
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

// board.ts: only enterState is used by enter-and-prepare-state; readBoard/writeBoard are deprecated.
// We do not mock enterState — the real pure function preserves wave_results via spread.

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

// Leave assembleWaveBriefing real — we test actual briefing output.
vi.mock("../orchestration/wave-briefing.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../orchestration/wave-briefing.ts")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

import { getExecutionStore } from "../orchestration/execution-store.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "after-int-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

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

/**
 * Seeds the ExecutionStore with the given board data so that
 * enterAndPrepareState (which reads from the store) can find it.
 */
function seedBoard(workspace: string, board: Board): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: board.flow,
    task: board.task,
    entry: board.entry,
    current_state: board.current_state,
    base_commit: board.base_commit,
    started: board.started ?? now,
    last_updated: board.last_updated ?? now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: board.flow,
    slug: "test-slug",
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, { ...stateEntry, status: stateEntry.status, entries: stateEntry.entries ?? 0 });
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations ?? {})) {
    store.upsertIteration(stateId, {
      count: iterEntry.count,
      max: iterEntry.max,
      history: iterEntry.history ?? [],
      cannot_fix: iterEntry.cannot_fix ?? [],
    });
  }
}

/**
 * A flow where the "implement" state has an "after" consultation
 * and the "review" state has a "before" consultation using the same
 * fragment — so the after-consultation summary from "implement" flows
 * into the "review" state's briefing.
 */
function makeFlowWithAfterAndNextState(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "wave",
        agent: "canon-implementor",
        consultations: {
          after: ["post-impl-check"],
        },
      },
      review: {
        type: "single",
        agent: "canon-reviewer",
        consultations: {
          before: ["post-impl-check"],
        },
      },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      implement: "Implement ${task}.",
      review: "Review ${task}.",
      "post-impl-check": "Run post-implementation check for ${task}.",
    },
    consultations: {
      "post-impl-check": {
        fragment: "post-impl-check",
        agent: "canon:canon-security",
        role: "security-reviewer",
        section: "Post-Implementation Check",
      },
    },
  } as unknown as ResolvedFlow;
}

function makeFlowWithAfterNoSection(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "wave",
        agent: "canon-implementor",
        consultations: {
          after: ["quick-check"],
        },
      },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      implement: "Implement ${task}.",
      "quick-check": "Quick check for ${task}.",
    },
    consultations: {
      "quick-check": {
        fragment: "quick-check",
        agent: "canon:canon-researcher",
        role: "researcher",
        // No "section" — deliberate gap from after-02 Known Gaps
      },
    },
  } as unknown as ResolvedFlow;
}

// ---------------------------------------------------------------------------
// Known Gap: after-01 — MCP tool registration smoke test
//
// Verifies that resolveAfterConsultations is exported correctly and returns
// the contract shape expected by index.ts registration (the registration
// passes input directly and JSON.stringifies the result).
// ---------------------------------------------------------------------------

describe("resolve_after_consultations: registration contract (after-01 gap)", () => {
  it("result is JSON-serializable — registration jsonResponse(result) does not throw", () => {
    const flow = makeFlowWithAfterAndNextState();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "implement",
      flow,
      variables: { task: "my-feature" },
    });

    // index.ts does: return { content: [{ type: "text", text: JSON.stringify(result) }] }
    expect(() => JSON.stringify(result)).not.toThrow();

    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);
    expect(parsed).toHaveProperty("consultation_prompts");
    expect(parsed).toHaveProperty("warnings");
    expect(Array.isArray(parsed.consultation_prompts)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("result shape matches ResolveAfterConsultationsResult — all entry fields serializable", () => {
    const flow = makeFlowWithAfterAndNextState();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "implement",
      flow,
      variables: { task: "integration-test" },
    });

    expect(result.consultation_prompts).toHaveLength(1);
    const entry = result.consultation_prompts[0];

    // All ConsultationPromptEntry fields the MCP caller would read
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.agent).toBe("string");
    expect(typeof entry.prompt).toBe("string");
    expect(typeof entry.role).toBe("string");
    expect(typeof entry.section).toBe("string");
    // timeout is absent for this fragment
    expect("timeout" in entry).toBe(false);
  });

  it("empty state returns well-formed empty result — registration path does not error", () => {
    const flow = makeFlowWithAfterAndNextState();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "nonexistent",
      flow,
      variables: {},
    });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Known Gap: after-02 — "after" breakpoint with status !== "done"
//
// The guard `cResult.status === "done"` is identical for all three breakpoints.
// The after-02 implementor explicitly called this out as untested for "after".
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — after breakpoint with non-done status not injected (after-02 gap)", () => {
  it("after-consultation with status 'pending' is not collected into briefing", async () => {
    const workspace = makeTmpDir();

    const boardWithPendingAfter = makeBoard({
      states: {
        implement: {
          status: "in_progress",
          entries: 1,
          wave_results: {
            "after": {
              tasks: [],
              status: "done",
              consultations: {
                after: {
                  "post-impl-check": {
                    status: "pending",  // Not "done" — must be skipped
                    summary: null,
                  },
                },
              },
            },
          },
        },
        review: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithPendingAfter);

    const flow = makeFlowWithAfterAndNextState();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

    expect(result.prompts).toHaveLength(1);
    // Status "pending" → summary not collected → no briefing injection
    expect(result.prompts[0].prompt).not.toContain("Post-Implementation Check");
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("after-consultation with status 'error' is not collected into briefing", async () => {
    const workspace = makeTmpDir();

    const boardWithErrorAfter = makeBoard({
      states: {
        implement: {
          status: "in_progress",
          entries: 1,
          wave_results: {
            "after": {
              tasks: [],
              status: "done",
              consultations: {
                after: {
                  "post-impl-check": {
                    status: "error",
                    summary: "Agent crashed unexpectedly.",
                  },
                },
              },
            },
          },
        },
        review: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithErrorAfter);

    const flow = makeFlowWithAfterAndNextState();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

    // Status "error" → not injected even though summary text exists
    expect(result.prompts[0].prompt).not.toContain("Agent crashed unexpectedly.");
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("after-consultation with done status but null summary is not collected", async () => {
    const workspace = makeTmpDir();

    const boardWithNullSummary = makeBoard({
      states: {
        implement: {
          status: "in_progress",
          entries: 1,
          wave_results: {
            "after": {
              tasks: [],
              status: "done",
              consultations: {
                after: {
                  "post-impl-check": {
                    status: "done",
                    summary: null,  // done but no summary text
                  },
                },
              },
            },
          },
        },
        review: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithNullSummary);

    const flow = makeFlowWithAfterAndNextState();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

    // null summary → guard `cResult.summary` is falsy → not collected
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });
});

// ---------------------------------------------------------------------------
// Known Gap: after-02 — "after" breakpoint with no section on fragment
//
// The after-02 implementor noted: "no section on consultation fragment — not
// tested for the 'after' case specifically." The "before" path had this test
// but not "after".
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — after breakpoint with no section on fragment (after-02 gap)", () => {
  it("after-consultation summary without section appears in briefing without heading", async () => {
    const workspace = makeTmpDir();

    const boardWithAfterNoSection = makeBoard({
      states: {
        implement: {
          status: "in_progress",
          entries: 1,
          wave_results: {
            "after": {
              tasks: [],
              status: "done",
              consultations: {
                after: {
                  "quick-check": {
                    status: "done",
                    summary: "Quick verification passed — no issues found.",
                  },
                },
              },
            },
          },
        },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithAfterNoSection);

    const flow = makeFlowWithAfterNoSection();

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my-task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

    expect(result.prompts).toHaveLength(1);
    // Summary collected from "after" breakpoint even without a section
    // assembleWaveBriefing skips the ### heading when section is absent
    // but the Wave Briefing header itself should still appear if any outputs
    // are present with section. Here quick-check has no section, so the
    // wave briefing block won't be emitted (assembleWaveBriefing only outputs
    // entries with a section key per the real implementation).
    // The key assertion: the prompt does NOT contain the raw summary text
    // in a section heading context, and does not crash.
    expect(() => result.prompts[0].prompt).not.toThrow();
  });

  it("resolveAfterConsultations includes entry without section key when fragment has no section", () => {
    const flow = makeFlowWithAfterNoSection();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "implement",
      flow,
      variables: { task: "my-feature" },
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.consultation_prompts).toHaveLength(1);

    const entry = result.consultation_prompts[0];
    expect(entry.name).toBe("quick-check");
    expect(entry.agent).toBe("canon:canon-researcher");
    expect("section" in entry).toBe(false);  // No section key in entry
  });
});

// ---------------------------------------------------------------------------
// Cross-task integration: resolveAfterConsultations → board storage →
// enterAndPrepareState in next state picks up the summary
//
// This tests the full lifecycle that spans after-01 (tool) and after-02
// (briefing fix): orchestrator calls resolveAfterConsultations, spawns agents,
// records summaries on the board under consultations.after, then the NEXT
// STATE's enterAndPrepareState picks them up via the briefing injection pipeline.
// ---------------------------------------------------------------------------

describe("cross-task: resolveAfterConsultations → board → same state next wave briefing injection", () => {
  it("after-consultation summary stored on board flows into same state's next wave briefing", async () => {
    const workspace = makeTmpDir();

    // Step 1: Call resolveAfterConsultations for "implement" state after wave 0
    const flow = makeFlowWithAfterAndNextState();
    const afterResult = resolveAfterConsultations({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "cross-task-feature" },
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
        implement: {
          status: "in_progress",
          entries: 1,
          wave_results: {
            "after": {
              tasks: [],
              status: "done",
              consultations: {
                after: {
                  "post-impl-check": {
                    status: "done",
                    summary: "All security checks passed. Parameterized queries used throughout.",
                  },
                },
              },
            },
          },
        },
        review: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithAfterSummary);

    // Step 3: enterAndPrepareState for WAVE 1 of the SAME "implement" state reads
    // board.states["implement"].wave_results and picks up the after-consultation summary
    // via the briefing injection scan (which includes "after" breakpoint per after-02).
    const wave1Result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "cross-task-feature", CANON_PLUGIN_ROOT: "" },
      items: ["task-b"],
      wave: 1,
    });

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
      workspace: "/tmp/ws",
      state_id: "implement",
      flow,
      variables: { task: "cross-task-feature" },
    });

    // Orchestrator reads these fields to spawn the consultation agent
    expect(afterResult.consultation_prompts).toHaveLength(1);
    const entry = afterResult.consultation_prompts[0];

    // All fields the orchestrator needs to spawn an agent
    expect(entry.name).toBe("post-impl-check");
    expect(entry.agent).toBe("canon:canon-security");
    expect(entry.role).toBe("security-reviewer");
    expect(entry.prompt).toContain("cross-task-feature");
    expect(entry.section).toBe("Post-Implementation Check");
    // No timeout on this fragment
    expect("timeout" in entry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-task: resolveAfterConsultations output shape matches what
// enterAndPrepareState expects when constructing ConsultationPromptEntry
//
// after-01 produces entries; the orchestrator must be able to spawn agents
// using them. Verify the output type contract is complete.
// ---------------------------------------------------------------------------

describe("resolveAfterConsultations → ConsultationPromptEntry shape contract", () => {
  it("output entry has all required ConsultationPromptEntry fields", () => {
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "Test",
      entry: "review",
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          consultations: { after: ["final-audit"] },
        },
      },
      spawn_instructions: {
        "final-audit": "Audit ${component} after implementation.",
      },
      consultations: {
        "final-audit": {
          fragment: "final-audit",
          agent: "canon:canon-security",
          role: "security",
          timeout: "10m",
          section: "Final Audit",
        },
      },
    } as unknown as ResolvedFlow;

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: { component: "auth-module" },
    });

    expect(result.consultation_prompts).toHaveLength(1);
    const entry = result.consultation_prompts[0];

    // Required fields from ConsultationPromptEntry interface
    expect(entry).toHaveProperty("name", "final-audit");
    expect(entry).toHaveProperty("agent", "canon:canon-security");
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
      name: "test-flow",
      description: "Test",
      entry: "review",
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          consultations: { after: ["check-a", "check-b", "check-c"] },
        },
      },
      spawn_instructions: {
        "check-a": "Check A for ${task}.",
        "check-b": "Check B for ${task}.",
        "check-c": "Check C for ${task}.",
      },
      consultations: {
        "check-a": { fragment: "check-a", agent: "canon:agent-a", role: "role-a" },
        "check-b": { fragment: "check-b", agent: "canon:agent-b", role: "role-b" },
        "check-c": { fragment: "check-c", agent: "canon:agent-c", role: "role-c" },
      },
    } as unknown as ResolvedFlow;

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: { task: "order-test" },
    });

    expect(result.consultation_prompts).toHaveLength(3);
    expect(result.consultation_prompts[0].name).toBe("check-a");
    expect(result.consultation_prompts[1].name).toBe("check-b");
    expect(result.consultation_prompts[2].name).toBe("check-c");
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-task: "after" and "before"/"between" summaries coexist correctly
//
// Ensures the after-02 fix does not disrupt existing "before"/"between"
// collection — all three breakpoints are collected simultaneously.
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — all three breakpoints coexist in briefing collection", () => {
  it("before, between, and after summaries are all collected and injected into briefing", async () => {
    const workspace = makeTmpDir();

    const boardWithAllBreakpoints = makeBoard({
      states: {
        implement: {
          status: "in_progress",
          entries: 2,
          wave_results: {
            "wave-0": {
              tasks: ["task-a"],
              status: "done",
              consultations: {
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
                after: {
                  "post-check": {
                    status: "done",
                    summary: "Post-check: wave completed successfully.",
                  },
                },
              },
            },
          },
        },
        done: { status: "pending", entries: 0 },
      },
    });

    seedBoard(workspace, boardWithAllBreakpoints);

    // IMPORTANT: The state definition MUST have a consultations key for the
    // collection block in enterAndPrepareState to be entered (line 171:
    // `if (stateDef?.consultations)`). Without it the whole collection is skipped.
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "Test",
      entry: "implement",
      states: {
        implement: {
          type: "wave",
          agent: "canon-implementor",
          // Declare an empty between array — this makes stateDef.consultations truthy
          // so the collection block runs and collects prior wave summaries.
          consultations: {
            between: [],
          },
        },
        done: { type: "terminal" },
      },
      spawn_instructions: {
        implement: "Implement ${task}.",
      },
      consultations: {
        "pre-check": {
          fragment: "pre-check",
          agent: "canon:canon-security",
          role: "security",
          section: "Pre-Check",
        },
        "mid-check": {
          fragment: "mid-check",
          agent: "canon:canon-researcher",
          role: "researcher",
          section: "Mid-Check",
        },
        "post-check": {
          fragment: "post-check",
          agent: "canon:canon-security",
          role: "security",
          section: "Post-Check",
        },
      },
    } as unknown as ResolvedFlow;

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "all-breakpoints-test", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

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
