/**
 * Unit tests for inject-templates.ts (Stage 5)
 *
 * Tests template injection into basePrompt.
 * One behavior per test.
 */

import { describe, it, expect } from "vitest";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { injectTemplates } from "../../tools/prompt-pipeline/inject-templates.ts";

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

function makeCtx(
  stateOverrides: Partial<StateDefinition> = {},
  variables: Record<string, string> = {},
  basePrompt = "Base prompt content",
): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent", ...stateOverrides };
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: "start",
      flow: makeFlow(),
      variables,
    },
    state,
    rawInstruction: "Do the thing",
    board: makeBoard(),
    mergedVariables: variables,
    basePrompt,
    prompts: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
