/**
 * Unit tests for validate.ts (Stage 9)
 *
 * Tests unresolved variable detection with PIPELINE_ALLOWED_VARIABLES allowlist.
 * One behavior per test.
 */

import { describe, it, expect } from "vitest";
import type { PromptContext, SpawnPromptEntry } from "../../tools/prompt-pipeline/types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { validatePrompts } from "../../tools/prompt-pipeline/validate.ts";

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

function makePromptEntry(prompt: string): SpawnPromptEntry {
  return {
    agent: "test-agent",
    prompt,
    template_paths: [],
  };
}

function makeCtx(
  prompts: SpawnPromptEntry[],
  basePrompt = "",
  warnings: string[] = [],
): PromptContext {
  const state: StateDefinition = { type: "single", agent: "test-agent" };
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: "start",
      flow: makeFlow(),
      variables: {},
    },
    state,
    rawInstruction: "Do the thing",
    board: makeBoard(),
    mergedVariables: {},
    basePrompt,
    prompts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validatePrompts (Stage 9)", () => {
  it("returns ctx unchanged (no warnings) for prompts with only allowed variables", async () => {
    const ctx = makeCtx([makePromptEntry("Do ${task} in ${WORKSPACE}")]);
    const result = await validatePrompts(ctx);
    // No ERROR warnings added
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("adds ERROR warning for unresolved unknown variable", async () => {
    const ctx = makeCtx([makePromptEntry("Do ${task} and ${totally_unknown_var}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("totally_unknown_var");
    expect(errorWarnings[0]).toContain("ERROR: unresolved variable");
  });

  it("includes state_id in the error warning message", async () => {
    const ctx = makeCtx([makePromptEntry("Use ${bad_variable}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings[0]).toContain('"start"');
  });

  it("does not flag escaped \\${...} patterns", async () => {
    const ctx = makeCtx([makePromptEntry("Literal \\${not_a_var} in prompt")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${item.anything} patterns (item.* allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Item field: ${item.my_custom_field}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${item} (exact match)", async () => {
    const ctx = makeCtx([makePromptEntry("Process ${item} from the list")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("flags unresolved ${messages} when inject_messages is not opted in", async () => {
    const ctx = makeCtx([makePromptEntry("Prior messages: ${messages}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("messages");
  });

  it("does not flag ${enrichment} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Context: ${enrichment}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${role} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Your role is: ${role}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${review_scope} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Review: ${review_scope}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${open_questions} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Questions: ${open_questions}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${directory} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Scan: ${directory}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${write_tests} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Write tests: ${write_tests}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("scans basePrompt when prompts array is empty (pre-fanout case)", async () => {
    const ctx = makeCtx([], "Use ${unknown_var_in_base}", []);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("unknown_var_in_base");
  });

  it("scans all prompts when multiple entries exist", async () => {
    const ctx = makeCtx([
      makePromptEntry("Prompt 1: ${bad_var_1}"),
      makePromptEntry("Prompt 2: ${bad_var_2}"),
    ]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(2);
    expect(errorWarnings.some(w => w.includes("bad_var_1"))).toBe(true);
    expect(errorWarnings.some(w => w.includes("bad_var_2"))).toBe(true);
  });

  it("preserves existing ctx.warnings when adding error warnings", async () => {
    const ctx = makeCtx([makePromptEntry("${bad_var}")], "", ["existing warning"]);
    const result = await validatePrompts(ctx);
    expect(result.warnings).toContain("existing warning");
  });

  it("does not flag ${WORKSPACE} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Workspace: ${WORKSPACE}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${wave_plans} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Plans: ${wave_plans}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${progress} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Progress: ${progress}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${project_structure} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Project layout: ${project_structure}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${conventions} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Project conventions: ${conventions}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter(w => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Known limitation documentation
  // ---------------------------------------------------------------------------

  it("documents known limitation: substituteVariables expands \\${x} when x is a known variable", async () => {
    // This is a known gap: substituteVariables regex matches \${var} even with
    // backslash prefix, so escaped variables with known names still get expanded.
    // The fix to substituteVariables regex is out of scope for ADR-006.
    // This test documents the behavior so it can't accidentally be "fixed" silently.
    const { substituteVariables } = await import("../../orchestration/variables.ts");

    // ${WORKSPACE} is a known variable — even with backslash prefix, it gets expanded
    const result = substituteVariables("Use \\${WORKSPACE} here", {
      WORKSPACE: "/my/workspace",
    });

    // KNOWN LIMITATION: backslash-escaped ${var} is still substituted when var is known
    // This means escaped patterns in injected content could still be expanded if
    // the variable name happens to match a runtime variable.
    // The correct fix is to update substituteVariables regex to skip \${...} patterns.
    expect(result).toBe("Use \\/my/workspace here");
  });
});
