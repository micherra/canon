/**
 * Unit tests for inject-templates.ts (Stage 5)
 *
 * Tests template injection into basePrompt.
 * One behavior per test.
 */

import { describe, expect, it } from "vitest";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { injectTemplates } from "../../tools/prompt-pipeline/inject-templates.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

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

function makeCtx(
  stateOverrides: Partial<StateDefinition> = {},
  variables: Record<string, string> = {},
  basePrompt = "Base prompt content",
): PromptContext {
  const state: StateDefinition = { agent: "test-agent", type: "single", ...stateOverrides };
  return {
    basePrompt,
    board: makeBoard(),
    input: {
      flow: makeFlow(),
      state_id: "start",
      variables,
      workspace: "/tmp/test-workspace",
    },
    mergedVariables: variables,
    prompts: [],
    rawInstruction: "Do the thing",
    state,
    warnings: [],
  };
}

describe("injectTemplates (Stage 5)", () => {
  it("returns ctx unchanged when state has no template field", async () => {
    const ctx = makeCtx(); // no template
    const result = await injectTemplates(ctx);
    expect(result).toBe(ctx); // same reference
  });

  it("appends template injection to basePrompt when template is declared", async () => {
    const ctx = makeCtx(
      { template: "review-checklist" },
      { CANON_PLUGIN_ROOT: "/plugins/canon" },
      "Base prompt content",
    );
    const result = await injectTemplates(ctx);
    expect(result.basePrompt).toContain("Base prompt content");
    expect(result.basePrompt).toContain("review-checklist");
    expect(result.basePrompt).toContain("/plugins/canon/templates/review-checklist.md");
  });

  it("appends injection after a double newline separator", async () => {
    const ctx = makeCtx(
      { template: "my-template" },
      { CANON_PLUGIN_ROOT: "/plugins" },
      "Base prompt",
    );
    const result = await injectTemplates(ctx);
    expect(result.basePrompt).toContain("Base prompt\n\n");
  });

  it("warns when CANON_PLUGIN_ROOT is empty and state has template", async () => {
    const ctx = makeCtx(
      { template: "some-template" },
      { CANON_PLUGIN_ROOT: "" }, // empty
      "Base prompt",
    );
    const result = await injectTemplates(ctx);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("CANON_PLUGIN_ROOT");
    expect(result.warnings[0]).toContain("skipping template injection");
    // basePrompt should be unchanged when plugin root is empty
    expect(result.basePrompt).toBe("Base prompt");
  });

  it("warns when CANON_PLUGIN_ROOT is absent (not in mergedVariables)", async () => {
    const ctx = makeCtx(
      { template: "some-template" },
      {}, // no CANON_PLUGIN_ROOT at all
      "Base prompt",
    );
    const result = await injectTemplates(ctx);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("CANON_PLUGIN_ROOT");
  });

  it("handles array of templates", async () => {
    const ctx = makeCtx(
      { template: ["template-a", "template-b"] },
      { CANON_PLUGIN_ROOT: "/plugins/canon" },
      "Base prompt",
    );
    const result = await injectTemplates(ctx);
    expect(result.basePrompt).toContain("template-a");
    expect(result.basePrompt).toContain("template-b");
  });

  it("preserves existing warnings when adding template warning", async () => {
    const ctx = {
      ...makeCtx({ template: "x" }, {}, "Base"),
      warnings: ["pre-existing warning"],
    };
    const result = await injectTemplates(ctx);
    expect(result.warnings).toContain("pre-existing warning");
    expect(result.warnings.length).toBe(2);
  });
});
