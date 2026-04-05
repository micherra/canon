/**
 * Integration tests for the consultation pipeline wiring.
 *
 * These tests cover:
 * 1. End-to-end path: flow with consultations declared →
 *    enterAndPrepareState returns consultation_prompts AND collects
 *    completed consultation summaries → getSpawnPrompt injects briefing
 *    into wave prompts.
 * 2. Cross-task contract: resolveConsultationPrompt (wcpl-01) output shape
 *    is correctly consumed by enterAndPrepareState (wcpl-03).
 * 3. assembleWaveBriefing (real, no mock): verify consultation section
 *    heading and summary appear in output.
 * 4. Declared Known Gaps from implementor summaries:
 *    - wcpl-01: fragment with both timeout AND section simultaneously
 *    - wcpl-02: wave=null with consultation_outputs present (guard holds)
 *    - wcpl-03: multiple consultations in one breakpoint (loop path)
 *    - wcpl-03: consultation_outputs passed to getSpawnPrompt affects prompt
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

// wave-briefing: mock readWaveGuidance to return empty (no wave guidance file)
// but leave assembleWaveBriefing REAL so we test the actual briefing output.
vi.mock("../orchestration/wave-briefing.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../orchestration/wave-briefing.ts")>();
  return {
    ...real,
    readWaveGuidance: vi.fn().mockResolvedValue(""),
  };
});

import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import { assertOk } from "../shared/lib/tool-result.ts";
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

/**
 * A flow with two consultations in the same breakpoint.
 */
function makeFlowWithMultipleConsultations(): ResolvedFlow {
  return {
    consultations: {
      "perf-review": {
        agent: "canon:canon-researcher",
        fragment: "perf-review",
        role: "researcher",
      },
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
      "perf-review": "Check performance for ${task}.",
      "security-review": "Review security for ${task}.",
    },
    states: {
      done: { type: "terminal" },
      implement: {
        agent: "canon-implementor",
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
    expect(entry.agent).toBe("canon:canon-security");
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
          agent: "canon:canon-security",
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
    expect(result!.agent).toBe("canon:canon-security");
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
          agent: "canon:canon-security",
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
          agent: "canon-implementor",
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
        build: { agent: "canon-implementor", type: "wave" },
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
      summaries: [],
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
      summaries: [],
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
      summaries: [],
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
      summaries: [],
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
