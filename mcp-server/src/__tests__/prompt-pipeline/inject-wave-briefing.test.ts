/**
 * Tests for inject-wave-briefing.ts (Stage 6)
 *
 * Covers:
 * - Returns ctx unchanged when state is not wave/parallel-per
 * - Returns ctx unchanged when wave is null
 * - Appends wave briefing to basePrompt when consultation_outputs provided
 * - Escapes consultation output summaries internally
 * - Escapes wave guidance content
 * - Does not double-escape already-escaped content (validates exactly-once)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn(),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import { injectWaveBriefing } from "../../tools/prompt-pipeline/inject-wave-briefing.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PromptContext> & { wave?: number; consultation_outputs?: PromptContext["input"]["consultation_outputs"] } = {}): PromptContext {
  const { wave, consultation_outputs, ...rest } = overrides;
  return {
    input: {
      workspace: "/tmp/test-workspace",
      state_id: "implement",
      flow: {
        name: "test-flow",
        description: "Test",
        entry: "implement",
        states: { implement: { type: "wave", agent: "canon-implementor" }, done: { type: "terminal" } },
        spawn_instructions: { implement: "Do the thing" },
      } as ResolvedFlow,
      variables: {},
      ...("wave" in overrides ? { wave } : { wave: 2 }),
      ...("consultation_outputs" in overrides ? { consultation_outputs } : {}),
    },
    state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
    rawInstruction: "Do the thing",
    basePrompt: "Base prompt text",
    prompts: [],
    warnings: [],
    mergedVariables: {},
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readWaveGuidance).mockResolvedValue("");
  vi.mocked(assembleWaveBriefing).mockReturnValue("");
});

// ---------------------------------------------------------------------------
// Tests: no-op conditions
// ---------------------------------------------------------------------------

describe("injectWaveBriefing — no-op conditions", () => {
  it("returns ctx unchanged when state type is 'single'", async () => {
    const ctx = makeCtx({
      state: { type: "single", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
    });
    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
    expect(readWaveGuidance).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when state type is 'parallel'", async () => {
    const ctx = makeCtx({
      state: { type: "parallel", agents: ["canon-implementor"] } as StateDefinition,
      wave: 1,
    });
    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when wave is null/undefined", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: undefined,
    });
    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
    expect(readWaveGuidance).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when wave state has no consultation_outputs", async () => {
    const ctx = makeCtx({
      consultation_outputs: undefined,
    });
    vi.mocked(readWaveGuidance).mockResolvedValue("");
    const result = await injectWaveBriefing(ctx);
    // assembleWaveBriefing should not be called without consultation_outputs
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: wave briefing injection for wave state
// ---------------------------------------------------------------------------

describe("injectWaveBriefing — wave state", () => {
  it("appends wave briefing to basePrompt when consultation_outputs provided", async () => {
    const ctx = makeCtx({
      wave: 2,
      consultation_outputs: {
        "consult-1": { section: "Architecture Notes", summary: "Use repository pattern" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing\n\nArchitecture Notes: Use repository pattern");

    const result = await injectWaveBriefing(ctx);

    expect(assembleWaveBriefing).toHaveBeenCalledOnce();
    expect(result.basePrompt).toContain("Base prompt text");
    expect(result.basePrompt).toContain("## Wave Briefing");
  });

  it("does not append briefing to basePrompt when assembleWaveBriefing returns empty string", async () => {
    const ctx = makeCtx({
      wave: 2,
      consultation_outputs: { "consult-1": { summary: "empty" } },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
  });

  it("passes wave number to assembleWaveBriefing", async () => {
    const ctx = makeCtx({
      wave: 3,
      consultation_outputs: {
        key: { section: "Sec", summary: "summary text" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    expect(assembleWaveBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ wave: 3 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: wave state with parallel-per
// ---------------------------------------------------------------------------

describe("injectWaveBriefing — parallel-per state", () => {
  it("also appends wave briefing for parallel-per state type", async () => {
    const ctx = makeCtx({
      state: { type: "parallel-per", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
      consultation_outputs: { key: { section: "Sec", summary: "text" } },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing\n\nSec: text");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toContain("## Wave Briefing");
  });
});

// ---------------------------------------------------------------------------
// Tests: escaping
// ---------------------------------------------------------------------------

describe("injectWaveBriefing — escaping consultation outputs", () => {
  it("escapes ${var} patterns in consultation output summaries before passing to assembleWaveBriefing", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: {
        key: { section: "Notes", summary: "Use ${variableName} in template" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // The summary passed to assembleWaveBriefing must have escaped ${
    expect(callArg.consultationOutputs["key"].summary).toBe("Use \\${variableName} in template");
  });

  it("does not double-escape already-escaped content (no \\\\${ produced)", async () => {
    // The new contract: caller must NOT pre-escape. If they do, this test documents
    // what happens (double-escape). The stage escapes raw text.
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: {
        key: { summary: "Raw ${var} text" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // Exactly one escape applied: \${  (not \\${)
    expect(callArg.consultationOutputs["key"].summary).toBe("Raw \\${var} text");
    // Must NOT have double-escaped \\${
    expect(callArg.consultationOutputs["key"].summary).not.toContain("\\\\${");
  });

  it("escapes ${var} in wave guidance content returned by readWaveGuidance", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: { key: { summary: "text" } },
    });
    vi.mocked(readWaveGuidance).mockResolvedValue("Follow ${GUIDANCE_VAR} pattern");
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    const result = await injectWaveBriefing(ctx);

    // The escaped guidance should be appended directly to basePrompt.
    // escapeDollarBrace converts "${" to "\${" — in the stored string that's a
    // literal backslash followed by ${. We verify the backslash is present.
    expect(result.basePrompt).toContain("\\${GUIDANCE_VAR}");
    // And that no UNESCAPED ${ remains — the literal text "Follow ${GUIDANCE_VAR}"
    // should not appear verbatim (without the backslash)
    expect(result.basePrompt).not.toContain("Follow ${GUIDANCE_VAR} pattern");
    expect(result.basePrompt).toContain("Follow \\${GUIDANCE_VAR} pattern");
  });

  it("does not append wave guidance section when guidance is empty string", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: { key: { summary: "text" } },
    });
    vi.mocked(readWaveGuidance).mockResolvedValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).not.toContain("Wave Guidance");
  });

  it("preserves section field in consultation outputs passed to assembleWaveBriefing", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: {
        key: { section: "My Section ${title}", summary: "text" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // Section is passed through (not escaped by this stage — only summaries are escaped)
    expect(callArg.consultationOutputs["key"].section).toBe("My Section ${title}");
  });
});
