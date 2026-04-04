/**
 * Unit tests for validate.ts (Stage 9)
 *
 * Tests unresolved variable detection with PIPELINE_ALLOWED_VARIABLES allowlist.
 * One behavior per test.
 */

import { describe, expect, it } from "vitest";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import type { PromptContext, SpawnPromptEntry } from "../../tools/prompt-pipeline/types.ts";
import { validatePrompts } from "../../tools/prompt-pipeline/validate.ts";

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
  const state: StateDefinition = { agent: "test-agent", type: "single" };
  return {
    basePrompt,
    board: makeBoard(),
    input: {
      flow: makeFlow(),
      state_id: "start",
      variables: {},
      workspace: "/tmp/test-workspace",
    },
    mergedVariables: {},
    prompts,
    rawInstruction: "Do the thing",
    state,
    warnings,
  };
}

describe("validatePrompts (Stage 9)", () => {
  it("returns ctx unchanged (no warnings) for prompts with only allowed variables", async () => {
    const ctx = makeCtx([makePromptEntry("Do ${task} in ${WORKSPACE}")]);
    const result = await validatePrompts(ctx);
    // No ERROR warnings added
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("adds ERROR warning for unresolved unknown variable", async () => {
    const ctx = makeCtx([makePromptEntry("Do ${task} and ${totally_unknown_var}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("totally_unknown_var");
    expect(errorWarnings[0]).toContain("ERROR: unresolved variable");
  });

  it("includes state_id in the error warning message", async () => {
    const ctx = makeCtx([makePromptEntry("Use ${bad_variable}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings[0]).toContain('"start"');
  });

  it("does not flag escaped \\${...} patterns", async () => {
    const ctx = makeCtx([makePromptEntry("Literal \\${not_a_var} in prompt")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${item.anything} patterns (item.* allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Item field: ${item.my_custom_field}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${item} (exact match)", async () => {
    const ctx = makeCtx([makePromptEntry("Process ${item} from the list")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("flags unresolved ${messages} when inject_messages is not opted in", async () => {
    const ctx = makeCtx([makePromptEntry("Prior messages: ${messages}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("messages");
  });

  it("does not flag ${enrichment} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Context: ${enrichment}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${role} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Your role is: ${role}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${review_scope} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Review: ${review_scope}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${open_questions} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Questions: ${open_questions}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${directory} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Scan: ${directory}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${write_tests} (in allowlist)", async () => {
    const ctx = makeCtx([makePromptEntry("Write tests: ${write_tests}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("scans basePrompt when prompts array is empty (pre-fanout case)", async () => {
    const ctx = makeCtx([], "Use ${unknown_var_in_base}", []);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("unknown_var_in_base");
  });

  it("scans all prompts when multiple entries exist", async () => {
    const ctx = makeCtx([
      makePromptEntry("Prompt 1: ${bad_var_1}"),
      makePromptEntry("Prompt 2: ${bad_var_2}"),
    ]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(2);
    expect(errorWarnings.some((w) => w.includes("bad_var_1"))).toBe(true);
    expect(errorWarnings.some((w) => w.includes("bad_var_2"))).toBe(true);
  });

  it("preserves existing ctx.warnings when adding error warnings", async () => {
    const ctx = makeCtx([makePromptEntry("${bad_var}")], "", ["existing warning"]);
    const result = await validatePrompts(ctx);
    expect(result.warnings).toContain("existing warning");
  });

  it("does not flag ${WORKSPACE} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Workspace: ${WORKSPACE}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${wave_plans} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Plans: ${wave_plans}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("does not flag ${progress} (in RUNTIME_VARIABLES)", async () => {
    const ctx = makeCtx([makePromptEntry("Progress: ${progress}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });

  it("flags ${project_structure} as unresolved (injected via cache prefix, not substitution)", async () => {
    const ctx = makeCtx([makePromptEntry("Project layout: ${project_structure}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("project_structure");
  });

  it("flags ${conventions} as unresolved (injected via cache prefix, not substitution)", async () => {
    const ctx = makeCtx([makePromptEntry("Project conventions: ${conventions}")]);
    const result = await validatePrompts(ctx);
    const errorWarnings = result.warnings.filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(1);
    expect(errorWarnings[0]).toContain("conventions");
  });

  // Known limitation documentation

  it("does not expand \\${x} even when x is a known variable (escape boundary fix)", async () => {
    // substituteVariables now skips \${...} patterns and unescapes them to ${...}.
    // This prevents KG summaries containing ${role} or similar from being expanded.
    const { substituteVariables } = await import("../../orchestration/variables.ts");

    // ${WORKSPACE} is a known variable — but with backslash prefix it must NOT expand
    const result = substituteVariables("Use \\${WORKSPACE} here", {
      WORKSPACE: "/my/workspace",
    });

    // Escaped pattern is preserved as literal ${WORKSPACE} (backslash stripped)
    expect(result).toBe("Use ${WORKSPACE} here");
  });
});
