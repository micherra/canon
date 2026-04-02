/**
 * Tests for assemble-prompt.ts — pipeline runner
 *
 * Covers:
 * - Terminal state returns empty prompts
 * - Missing state returns skip_reason
 * - Missing rawInstruction returns skip_reason
 * - skip_when triggers skip_reason
 * - Pipeline produces prompts for a simple single state
 * - Pipeline produces prompts for wave state with items
 * - _board optimization: pre-read board is used without store call
 * - Consultation outputs without pre-escaping are escaped by pipeline (single escape)
 * - Pre-escaped consultation output is double-escaped (documents new contract)
 * - Unresolved variables in final prompt produce ERROR warnings (validate stage integration)
 * - Stage 3 integration: state with inject_messages produces prompt with message content
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const mockStore = {
  getBoard: vi.fn(),
  getProgress: vi.fn().mockReturnValue(""),
  appendProgress: vi.fn(),
  getExecution: vi.fn(),
  getCachePrefix: vi.fn().mockReturnValue(""),
};

vi.mock("../../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

vi.mock("../../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

vi.mock("../../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn().mockResolvedValue({
    variables: {},
    warnings: [],
    hitl: undefined,
  }),
}));

vi.mock("../../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(""),
}));

vi.mock("../../orchestration/messages.ts", () => ({
  readChannelAsContext: vi.fn().mockResolvedValue(""),
  buildMessageInstructions: vi.fn().mockReturnValue("msg-instr"),
}));

vi.mock("../../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("../../orchestration/debate.ts", () => ({
  inspectDebateProgress: vi.fn().mockResolvedValue({ completed: true, summary: "" }),
  buildDebatePrompt: vi.fn().mockReturnValue(""),
  debateTeamLabel: vi.fn(),
}));

vi.mock("../../orchestration/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn().mockReturnValue([]),
}));

import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { evaluateSkipWhen } from "../../orchestration/skip-when.ts";
import { readChannelAsContext } from "../../orchestration/messages.ts";
import { assembleWaveBriefing } from "../../orchestration/wave-briefing.ts";
import { assemblePrompt } from "../../tools/prompt-pipeline/assemble-prompt.ts";
import type { Board, ResolvedFlow } from "../../orchestration/flow-schema.ts";
import type { SpawnPromptInput } from "../../tools/prompt-pipeline/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: { type: "single", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { implement: "Implement the task." },
    ...overrides,
  };
}

function makeInput(overrides: Partial<SpawnPromptInput> = {}): SpawnPromptInput {
  return {
    workspace: "/tmp/test-workspace",
    state_id: "implement",
    flow: makeFlow(),
    variables: { CANON_PLUGIN_ROOT: "" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.getBoard.mockReturnValue(makeBoard());
  mockStore.getProgress.mockReturnValue("");
  mockStore.getCachePrefix.mockReturnValue("");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Early returns
// ---------------------------------------------------------------------------

describe("assemblePrompt — terminal state", () => {
  it("returns empty prompts and state_type terminal for terminal states", async () => {
    const input = makeInput({
      state_id: "done",
      flow: makeFlow(),
    });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.state_type).toBe("terminal");
    expect(result.skip_reason).toBeUndefined();
  });
});

describe("assemblePrompt — missing state", () => {
  it("returns skip_reason when state_id not found in flow", async () => {
    const input = makeInput({ state_id: "nonexistent" });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("nonexistent");
    expect(result.skip_reason).toContain("not found");
  });
});

describe("assemblePrompt — missing rawInstruction", () => {
  it("returns skip_reason when no spawn instruction for state", async () => {
    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: {}, // no instruction for implement
    });
    const input = makeInput({ flow });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("No spawn instruction");
  });
});

describe("assemblePrompt — skip_when", () => {
  it("returns skip_reason when skip_when condition is met", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValueOnce({
      skip: true,
      reason: "already done",
    });

    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", skip_when: "auto_approved" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput({ flow });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("already done");
  });

  it("does not skip when skip_when condition is not met", async () => {
    vi.mocked(evaluateSkipWhen).mockResolvedValueOnce({ skip: false });

    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", skip_when: "auto_approved" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput({ flow });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(1);
    expect(result.skip_reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline produces prompts
// ---------------------------------------------------------------------------

describe("assemblePrompt — simple single state", () => {
  it("produces one prompt for a single-agent state", async () => {
    const input = makeInput();
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.state_type).toBe("single");
    expect(result.skip_reason).toBeUndefined();
  });

  it("prompt contains the rawInstruction text", async () => {
    const input = makeInput({
      flow: makeFlow({ spawn_instructions: { implement: "Do the work now." } }),
    });
    const result = await assemblePrompt(input);

    expect(result.prompts[0].prompt).toContain("Do the work now.");
  });

  it("includes metrics footer in every prompt", async () => {
    const input = makeInput();
    const result = await assemblePrompt(input);

    expect(result.prompts[0].prompt).toContain("record_agent_metrics");
  });
});

describe("assemblePrompt — wave state with items", () => {
  it("produces one prompt per item for wave state", async () => {
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput({
      state_id: "build",
      flow,
      items: ["task-1", "task-2", "task-3"],
      wave: 1,
    });
    const result = await assemblePrompt(input);

    expect(result.prompts).toHaveLength(3);
    expect(result.state_type).toBe("wave");
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.prompts[0].prompt).toContain("Build task-1");
    expect(result.prompts[1].prompt).toContain("Build task-2");
    expect(result.prompts[2].prompt).toContain("Build task-3");
  });

  it("sets isolation=worktree on wave prompt entries", async () => {
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput({
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
    });
    const result = await assemblePrompt(input);

    expect(result.prompts[0].isolation).toBe("worktree");
  });
});

// ---------------------------------------------------------------------------
// _board optimization
// ---------------------------------------------------------------------------

describe("assemblePrompt — _board optimization", () => {
  it("uses pre-read _board without calling getExecutionStore for board", async () => {
    const board = makeBoard({ current_state: "implement" });
    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", skip_when: "auto_approved" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput({ flow, _board: board });

    vi.mocked(evaluateSkipWhen).mockResolvedValueOnce({ skip: false });

    await assemblePrompt(input);

    // getBoard should NOT be called since _board was provided
    expect(mockStore.getBoard).not.toHaveBeenCalled();
  });

  it("calls store.getBoard when _board is not provided and skip_when needs board", async () => {
    const board = makeBoard();
    mockStore.getBoard.mockReturnValue(board);

    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", skip_when: "auto_approved" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput({ flow }); // no _board

    vi.mocked(evaluateSkipWhen).mockResolvedValueOnce({ skip: false });

    await assemblePrompt(input);

    expect(mockStore.getBoard).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Escaping ownership transfer
// ---------------------------------------------------------------------------

describe("assemblePrompt — consultation output escaping", () => {
  it("escapes raw ${var} in consultation summary exactly once", async () => {
    vi.mocked(assembleWaveBriefing).mockImplementation((opts) => {
      // Return the escaped summaries so we can verify
      const outputs = opts.consultationOutputs;
      if (!outputs) return "";
      const summaries = Object.values(outputs).map((o) => o.summary);
      return `Briefing: ${summaries.join(", ")}`;
    });

    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput({
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
      consultation_outputs: {
        research: { summary: "Use ${pattern} here" },
      },
    });

    const result = await assemblePrompt(input);

    // The briefing text should contain escaped ${ (not double-escaped \\${)
    const allPromptText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allPromptText).toContain("Use \\${pattern} here");
    expect(allPromptText).not.toContain("\\\\${pattern}");
  });

  it("double-escapes pre-escaped consultation summary — documents new contract", async () => {
    vi.mocked(assembleWaveBriefing).mockImplementation((opts) => {
      const outputs = opts.consultationOutputs;
      if (!outputs) return "";
      const summaries = Object.values(outputs).map((o) => o.summary);
      return `Briefing: ${summaries.join(", ")}`;
    });

    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput({
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
      consultation_outputs: {
        // Pre-escaped by caller — this is WRONG under the new contract
        research: { summary: "Use \\${pattern} here" },
      },
    });

    const result = await assemblePrompt(input);

    // Stage 6 escapes again, producing double-escape — documents that callers must NOT pre-escape
    const allPromptText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allPromptText).toContain("\\\\${pattern}");
  });
});

// ---------------------------------------------------------------------------
// Validate stage integration
// ---------------------------------------------------------------------------

describe("assemblePrompt — validate stage (unresolved variables)", () => {
  it("produces ERROR warning for unresolved variables in final prompt", async () => {
    const flow = makeFlow({
      spawn_instructions: { implement: "Do the work for ${unknown_var}." },
    });
    const input = makeInput({ flow });
    const result = await assemblePrompt(input);

    const hasError = (result.warnings ?? []).some(
      (w) => w.startsWith("ERROR:") && w.includes("unknown_var"),
    );
    expect(hasError).toBe(true);
  });

  it("does not warn for allowed runtime variables", async () => {
    const flow = makeFlow({
      spawn_instructions: { implement: "Do the work for ${task} ${WORKSPACE}." },
    });
    const input = makeInput({ flow });
    const result = await assemblePrompt(input);

    const hasError = (result.warnings ?? []).some((w) => w.startsWith("ERROR:"));
    expect(hasError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 integration: inject_messages
// ---------------------------------------------------------------------------

describe("assemblePrompt — Stage 3 inject_messages", () => {
  it("injects message content when state has inject_messages: true and channel has content", async () => {
    vi.mocked(readChannelAsContext).mockResolvedValueOnce("Message from peer: done.");

    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", inject_messages: true } as ResolvedFlow["states"][string],
        done: { type: "terminal" },
      },
      spawn_instructions: { implement: "Do the work. Context: ${messages}" },
    });
    const input = makeInput({ flow });

    const result = await assemblePrompt(input);

    expect(result.prompts[0].prompt).toContain("Message from peer: done.");
  });

  it("leaves ${messages} unresolved when inject_messages is false", async () => {
    const flow = makeFlow({
      spawn_instructions: { implement: "Do the work. Context: ${messages}" },
    });
    const input = makeInput({ flow });

    const result = await assemblePrompt(input);

    // messages not injected — ${messages} either unresolved (in warnings) or absent
    expect(readChannelAsContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No consultation_outputs — no error
// ---------------------------------------------------------------------------

describe("assemblePrompt — absent consultation_outputs", () => {
  it("does not throw when consultation_outputs is absent", async () => {
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput({
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
      // no consultation_outputs
    });

    await expect(assemblePrompt(input)).resolves.not.toThrow();
    const result = await assemblePrompt(input);
    expect(result.prompts).toHaveLength(1);
  });
});
