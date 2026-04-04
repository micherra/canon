/**
 * Unit tests for resolve-messages.ts (Stage 3)
 *
 * Tests channel message injection with escapeDollarBrace at read boundary.
 * One behavior per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

// Hoist vi.mock — must come before imports that use the mocks

vi.mock("../../orchestration/messages.ts", () => ({
  readChannelAsContext: vi.fn(),
}));

import { readChannelAsContext } from "../../orchestration/messages.ts";
import { resolveMessages } from "../../tools/prompt-pipeline/resolve-messages.ts";

function makeBoard(): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
  };
}

function makeFlow(): ResolvedFlow {
  return {
    description: "test flow",
    entry: "start",
    name: "test",
    spawn_instructions: { start: "Do the thing" },
    states: {
      done: { type: "terminal" },
      start: { agent: "test-agent", type: "single" },
    },
  };
}

function makeCtx(stateOverrides: Partial<StateDefinition> = {}, stateId = "start"): PromptContext {
  const state: StateDefinition = { agent: "test-agent", type: "single", ...stateOverrides };
  return {
    basePrompt: "",
    board: makeBoard(),
    input: {
      flow: makeFlow(),
      state_id: stateId,
      variables: {},
      workspace: "/tmp/test-workspace",
    },
    mergedVariables: {},
    prompts: [],
    rawInstruction: "Do the thing",
    state,
    warnings: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

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
    expect(vi.mocked(readChannelAsContext)).toHaveBeenCalledWith("/tmp/test-workspace", stateId);
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
