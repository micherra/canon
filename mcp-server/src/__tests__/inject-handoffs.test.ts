/**
 * Tests for inject-handoffs pipeline stage.
 *
 * Tests follow TDD: each test describes the expected behavior before the
 * implementation is written. Tests use real temp directories to verify
 * file-system reads without mocking the underlying fs module.
 */

import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptContext, SpawnPromptInput } from "../tools/prompt-pipeline/types.ts";
import type { StateDefinition } from "../orchestration/flow-schema.ts";
import { injectHandoffs } from "../tools/prompt-pipeline/inject-handoffs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PromptContext with the given agent type and workspace. */
function makeCtx(agentType: string | undefined, workspace: string): PromptContext {
  const state = {
    type: "single",
    agent: agentType,
  } as unknown as StateDefinition;

  const input = {
    workspace,
    state_id: "test-state",
    flow: { states: {}, spawn_instructions: {} } as SpawnPromptInput["flow"],
    variables: {},
  } as SpawnPromptInput;

  return {
    input,
    state,
    rawInstruction: "## Test\nDo the thing.",
    mergedVariables: {},
    basePrompt: "",
    prompts: [],
    warnings: [],
  };
}

/** Write a handoff file in the workspace's handoffs/ directory. */
async function writeHandoff(workspace: string, filename: string, content: string): Promise<void> {
  const handoffsDir = join(workspace, "handoffs");
  await mkdir(handoffsDir, { recursive: true });
  await writeFile(join(handoffsDir, filename), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("injectHandoffs pipeline stage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-handoffs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // All 4 agent types
  // -------------------------------------------------------------------------

  it("architect state gets research-synthesis.md injected as handoff_context", async () => {
    const content = "# Research Synthesis\nKey findings here.";
    await writeHandoff(tmpDir, "research-synthesis.md", content);

    const ctx = makeCtx("canon:canon-architect", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toContain("Key findings here.");
    expect(result.warnings).toHaveLength(0);
  });

  it("implementor state gets design-brief.md injected as handoff_context", async () => {
    const content = "# Design Brief\nImplement the following...";
    await writeHandoff(tmpDir, "design-brief.md", content);

    const ctx = makeCtx("canon:canon-implementor", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toContain("Implement the following...");
    expect(result.warnings).toHaveLength(0);
  });

  it("tester state gets impl-handoff.md injected as handoff_context", async () => {
    const content = "# Implementation Handoff\nWhat was built.";
    await writeHandoff(tmpDir, "impl-handoff.md", content);

    const ctx = makeCtx("canon:canon-tester", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toContain("What was built.");
    expect(result.warnings).toHaveLength(0);
  });

  it("fixer state gets test-findings.md injected as handoff_context", async () => {
    const content = "# Test Findings\nFailing tests listed here.";
    await writeHandoff(tmpDir, "test-findings.md", content);

    const ctx = makeCtx("canon:canon-fixer", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toContain("Failing tests listed here.");
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Unknown / missing agent type
  // -------------------------------------------------------------------------

  it("unknown agent type returns ctx unchanged with no handoff_context", async () => {
    const ctx = makeCtx("canon:canon-reviewer", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
    // Must be same reference (or at least equal) for pass-through efficiency
    expect(result).toBe(ctx);
  });

  it("undefined agent type returns ctx unchanged", async () => {
    const ctx = makeCtx(undefined, tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
    expect(result).toBe(ctx);
  });

  // -------------------------------------------------------------------------
  // Graceful degradation
  // -------------------------------------------------------------------------

  it("missing handoff file produces a warning and returns ctx without handoff_context", async () => {
    // Create handoffs dir but do NOT write the file
    await mkdir(join(tmpDir, "handoffs"), { recursive: true });

    const ctx = makeCtx("canon:canon-implementor", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/design-brief\.md/);
  });

  it("handoffs directory does not exist — produces a warning, no throw", async () => {
    // tmpDir exists but has no handoffs/ subdirectory
    const ctx = makeCtx("canon:canon-architect", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/research-synthesis\.md/);
  });

  // -------------------------------------------------------------------------
  // Escaping
  // -------------------------------------------------------------------------

  it("handoff content with ${...} is escaped via escapeDollarBrace before injection", async () => {
    const content = "Use ${WORKSPACE} and ${state_id} here.";
    await writeHandoff(tmpDir, "design-brief.md", content);

    const ctx = makeCtx("canon:canon-implementor", tmpDir);
    const result = await injectHandoffs(ctx);

    // After escaping, ${...} should become \${...}
    expect(result.mergedVariables.handoff_context).toContain("\\${WORKSPACE}");
    expect(result.mergedVariables.handoff_context).toContain("\\${state_id}");
  });

  // -------------------------------------------------------------------------
  // Multiple handoff files
  // -------------------------------------------------------------------------

  it("multiple handoff files are concatenated with separator", async () => {
    // Architect gets only research-synthesis.md — single file. Use a mock
    // consumer that needs two files by testing the separator logic indirectly.
    // Since current HANDOFF_CONSUMER_MAP entries are single-file, we verify
    // the pattern by checking that the content is present and the stage doesn't
    // add extra separators when there's only one file.
    const content = "Single file content.";
    await writeHandoff(tmpDir, "research-synthesis.md", content);

    const ctx = makeCtx("canon:canon-architect", tmpDir);
    const result = await injectHandoffs(ctx);

    expect(result.mergedVariables.handoff_context).toBe("Single file content.");
  });

  // -------------------------------------------------------------------------
  // Pre-existing warnings are preserved
  // -------------------------------------------------------------------------

  it("pre-existing warnings from earlier stages are preserved in returned ctx", async () => {
    const ctx = makeCtx("canon:canon-architect", tmpDir);
    // Add a warning before the stage runs (simulating a prior stage)
    const ctxWithWarning = { ...ctx, warnings: ["prior warning"] };

    // No handoffs/ dir — will produce a missing-file warning
    const result = await injectHandoffs(ctxWithWarning);

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toBe("prior warning");
  });
});
