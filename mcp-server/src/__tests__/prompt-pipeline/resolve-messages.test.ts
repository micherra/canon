/**
 * Unit tests for resolve-messages.ts (Stage 3)
 *
 * Tests channel message injection with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist vi.mock — must come before imports that use the mocks
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/messages.ts", () => ({
  readChannelAsContext: vi.fn(),
}));

import { readChannelAsContext } from "../../orchestration/messages.ts";
import { resolveMessages } from "../../tools/prompt-pipeline/resolve-messages.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

function makeFlow(): ResolvedFlow {
  return {
    name: "test",
    description: "test flow",
    entry: "start",
    states: {
      start: { type: "single", agent: "test-agent" },
      done: { type: "terminal" },
    },
    spawn_instructions: { start: "Do the thing" },
  };
}

function makeCtx(stateOverrides: Partial<StateDefinition> = {}, stateId = "start"): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent", ...stateOverrides };
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: stateId,
      flow: makeFlow(),
      variables: {},
    },
    state,
    rawInstruction: "Do the thing",
    board: makeBoard(),
    mergedVariables: {},
    basePrompt: "",
    prompts: [],
    warnings: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveMessages (Stage 3)", () => {
  it("returns ctx unchanged when state has no inject_messages field", async () => {
    const ctx = makeCtx(); // no inject_messages
    const result = await resolveMessages(ctx);
    expect(result).toBe(ctx); // same reference
    expect(vi.mocked(readChannelAsContext)).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when inject_messages is false", async () => {
    const ctx = makeCtx({ inject_messages: false });
    const result = await resolveMessages(ctx);
    expect(result).toBe(ctx);
    expect(vi.mocked(readChannelAsContext)).not.toHaveBeenCalled();
  });

  it("reads channel messages and sets mergedVariables.messages when inject_messages is true", async () => {
    const ctx = makeCtx({ inject_messages: true });
    vi.mocked(readChannelAsContext).mockResolvedValue("**agent-1:**\nplain message content");

    const result = await resolveMessages(ctx);
    expect(result.mergedVariables.messages).toBe("**agent-1:**\nplain message content");
  });

  it("escapes ${...} patterns in message content", async () => {
    const ctx = makeCtx({ inject_messages: true });
    vi.mocked(readChannelAsContext).mockResolvedValue("content with ${WORKSPACE} in it");

    const result = await resolveMessages(ctx);
    // escapeDollarBrace must have run — ${WORKSPACE} becomes \${WORKSPACE}
    expect(result.mergedVariables.messages).toBe("content with \\${WORKSPACE} in it");
  });

  it("does not set mergedVariables.messages when channel is empty", async () => {
    const ctx = makeCtx({ inject_messages: true });
    vi.mocked(readChannelAsContext).mockResolvedValue(""); // empty channel

    const result = await resolveMessages(ctx);
    // When channel is empty, messages variable is not set
    expect(result.mergedVariables.messages).toBeUndefined();
    // But returns a new ctx (not same reference) because we still called the function
    // Actually for empty, we return unchanged ctx
    expect(result).toBe(ctx);
  });

  it("uses state_id as the channel name", async () => {
    const stateId = "my-implement-state";
    const ctx = makeCtx({ inject_messages: true }, stateId);
    vi.mocked(readChannelAsContext).mockResolvedValue("some message");

    await resolveMessages(ctx);
    expect(vi.mocked(readChannelAsContext)).toHaveBeenCalledWith(
      "/tmp/test-workspace",
      stateId,
    );
  });

  it("uses workspace from input when calling readChannelAsContext", async () => {
    const ctx = makeCtx({ inject_messages: true });
    vi.mocked(readChannelAsContext).mockResolvedValue("a message");

    await resolveMessages(ctx);
    expect(vi.mocked(readChannelAsContext)).toHaveBeenCalledWith(
      "/tmp/test-workspace",
      expect.any(String),
    );
  });
});
