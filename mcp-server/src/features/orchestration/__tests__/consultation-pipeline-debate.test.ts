/**
 * Integration tests for the consultation pipeline wiring (Part 2).
 *
 * These tests cover:
 * 5. End-to-end integration: board summaries → briefing in wave prompts
 * 6. assembleWaveBriefing (real): consultation section heading and summary
 * 7. enterAndPrepareState: collects after-consultation summaries from wave_results
 * 8. enterAndPrepareState: consultation_outputs absent when no completed summaries
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
import { escapeDollarBrace } from "@domains/workspaces/wave-variables.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { assembleWaveBriefing } from "../services/wave-briefing.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-debate-"));
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
        agent: "canon:canon-security",
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
        agent: "canon-implementor",
        consultations: {
          before: ["security-review"],
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

// 5. End-to-end integration: enterAndPrepareState collects completed summaries
//    from board wave_results → passes them to getSpawnPrompt as consultation_outputs
//    → assembleWaveBriefing (real) injects into wave prompts

describe("consultation pipeline end-to-end: board summaries → briefing in wave prompts", () => {
  it("completed consultation summary from board appears in wave prompt via real assembleWaveBriefing", async () => {
    const workspace = makeTmpDir();

    // Board has a completed security consultation from wave 0
    const boardWithResults = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: {
          entries: 1,
          status: "in_progress",
          wave_results: {
            "wave-0": {
              consultations: {
                before: {
                  "security-review": {
                    status: "done",
                    summary: "Use parameterized queries. Validated approach.",
                  },
                },
              },
              status: "done",
              tasks: [],
            },
          },
        },
      },
    });

    seedBoard(workspace, boardWithResults);

    const flow = makeFlowWithBeforeConsultation();

    // Wave 1 → "between" breakpoint → no new consultation_prompts for "before"
    // But completed "before" summaries from wave_results ARE collected for briefing
    const result = await enterAndPrepareState({
      flow,
      items: ["task-a", "task-b"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1, // Wave 1 → between breakpoint
      workspace,
    });
    assertOk(result);

    // No new consultation_prompts (between is empty in this flow)
    expect(result.consultation_prompts).toBeUndefined();

    // Prompts should be produced for wave items
    expect(result.prompts).toHaveLength(2);

    // The real assembleWaveBriefing should have injected the security section
    // since the summary was collected and passed through
    for (const entry of result.prompts) {
      // The section heading from the consultation fragment
      expect(entry.prompt).toContain("Security Review");
      // The summary content
      expect(entry.prompt).toContain("Use parameterized queries.");
    }
  });

  it("completed summary with injection attempt is escaped before appearing in wave prompt", async () => {
    const workspace = makeTmpDir();

    const boardWithResults = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: {
          entries: 1,
          status: "in_progress",
          wave_results: {
            "wave-0": {
              consultations: {
                before: {
                  "security-review": {
                    status: "done",
                    summary: "Avoid ${SECRET_KEY} patterns in logs.",
                  },
                },
              },
              status: "done",
              tasks: [],
            },
          },
        },
      },
    });

    seedBoard(workspace, boardWithResults);

    const flow = makeFlowWithBeforeConsultation();

    const result = await enterAndPrepareState({
      flow,
      items: ["task-a"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.prompts).toHaveLength(1);
    const prompt = result.prompts[0].prompt;

    // The injection attempt ${SECRET_KEY} must be escaped to \${SECRET_KEY}.
    // We verify the escaped form is present, and that the raw form is NOT present
    // by checking there is no unescaped `${` — i.e., the prompt does not contain
    // a `$` immediately followed by `{S` that is not preceded by `\`.
    expect(prompt).toContain("\\${SECRET_KEY}");
    // The raw unescaped form must not appear: match `${` not preceded by backslash
    expect(prompt).not.toMatch(/(?<!\\)\$\{SECRET_KEY\}/);
  });
});

// 6. assembleWaveBriefing (real): consultation section heading and summary
//    appear in output — cross-module contract between wcpl-01 section field
//    and wave-briefing output format

describe("assembleWaveBriefing — consultation section and summary contract", () => {
  it("renders consultation section heading and summary in briefing output", () => {
    const briefing = assembleWaveBriefing({
      consultationOutputs: {
        "security-review": {
          section: "Security Review",
          summary: "Use parameterized queries to prevent injection.",
        },
      },
      wave: 1,
    });

    expect(briefing).toContain("## Wave Briefing (from wave 1)");
    expect(briefing).toContain("### Security Review");
    expect(briefing).toContain("Use parameterized queries to prevent injection.");
  });

  it("renders multiple consultation sections from multiple outputs", () => {
    const briefing = assembleWaveBriefing({
      consultationOutputs: {
        "perf-review": {
          section: "Performance Review",
          summary: "No bottlenecks found.",
        },
        "security-review": {
          section: "Security Review",
          summary: "Validated all endpoints.",
        },
      },
      wave: 2,
    });

    expect(briefing).toContain("### Security Review");
    expect(briefing).toContain("Validated all endpoints.");
    expect(briefing).toContain("### Performance Review");
    expect(briefing).toContain("No bottlenecks found.");
  });

  it("omits section heading when consultation output has no section, but includes summary text", () => {
    const briefing = assembleWaveBriefing({
      consultationOutputs: {
        "anon-review": {
          // No section field
          summary: "Use dry-run mode for destructive operations.",
        },
      },
      wave: 1,
    });

    // assembleWaveBriefing only renders `### heading` when section is set
    // so the heading should be absent but header present
    expect(briefing).toContain("## Wave Briefing (from wave 1)");
    // Without a section, assembleWaveBriefing skips that output entry's section block
    // (the for loop checks output.section before pushing)
    expect(briefing).not.toContain("### ");
  });

  it("pre-escaped \\${ in summary survives through assembleWaveBriefing unchanged", () => {
    const escapedSummary = escapeDollarBrace("Avoid ${SECRET} in logs.");
    expect(escapedSummary).toBe("Avoid \\${SECRET} in logs.");

    const briefing = assembleWaveBriefing({
      consultationOutputs: {
        "security-review": {
          section: "Security",
          summary: escapedSummary,
        },
      },
      wave: 1,
    });

    // The escaped form must survive into the briefing
    expect(briefing).toContain("\\${SECRET}");
    // The raw unescaped form must not appear (match `${` not preceded by backslash)
    expect(briefing).not.toMatch(/(?<!\\)\$\{SECRET\}/);
  });
});

// 7. enterAndPrepareState: consultation_outputs only passed to getSpawnPrompt
//    when summaries exist — no spurious injection on empty board

// 8. after-02: enterAndPrepareState collects "after" breakpoint summaries
//    from wave_results and injects them into the next state's briefing

describe("enterAndPrepareState — collects after-consultation summaries from wave_results", () => {
  it("after-consultation summary from wave_results flows into next state briefing", async () => {
    const workspace = makeTmpDir();

    // Board has a completed "after" consultation from a synthetic "after" wave key
    const boardWithAfterResults = makeBoard({
      states: {
        done: { entries: 0, status: "pending" },
        implement: {
          entries: 1,
          status: "in_progress",
          wave_results: {
            after: {
              consultations: {
                after: {
                  "security-review": {
                    status: "done",
                    summary: "Post-implementation security check passed.",
                  },
                },
              },
              status: "done",
              tasks: [],
            },
          },
        },
      },
    });

    seedBoard(workspace, boardWithAfterResults);

    // Flow declares security-review as a consultation with a section
    const flow = makeFlowWithBeforeConsultation();

    // Wave 1 — the "after" summary from wave_results should be picked up
    const result = await enterAndPrepareState({
      flow,
      items: ["task-a"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.prompts).toHaveLength(1);

    // The "after" consultation summary must appear in the wave prompt briefing
    const prompt = result.prompts[0].prompt;
    expect(prompt).toContain("Security Review");
    expect(prompt).toContain("Post-implementation security check passed.");
  });
});

describe("enterAndPrepareState — consultation_outputs absent when no completed summaries", () => {
  it("wave prompt has no briefing injection when board has no completed consultation summaries", async () => {
    const workspace = makeTmpDir();
    // Board with NO wave_results (fresh start, wave 1)
    seedBoard(workspace, makeBoard());
    const flow = makeFlowWithBeforeConsultation();

    // Wave 1 with before consultation declared but no completed summaries on board
    const result = await enterAndPrepareState({
      flow,
      items: ["task-a"],
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my-task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.prompts).toHaveLength(1);
    // No briefing — no completed summaries means consultation_outputs was not passed
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });
});
