/**
 * Tests for inject-wave-briefing.ts (Stage 6) — Part 1
 *
 * Covers:
 * - Returns ctx unchanged when state is not wave/parallel-per
 * - Returns ctx unchanged when wave is null
 * - Appends wave briefing to basePrompt when consultation_outputs provided
 * - Escapes consultation output summaries internally
 * - Escapes wave guidance content
 * - Does not double-escape already-escaped content (validates exactly-once)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@features/orchestration/services/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn(),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

vi.mock("@graph/kg-query-insights.ts", () => ({
  computeFileInsightMaps: vi.fn(),
}));

vi.mock("@graph/kg-query.ts", () => ({
  KgQuery: vi.fn(),
}));

vi.mock("@graph/kg-store.ts", () => ({
  KgStore: vi.fn(),
}));

vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("@domains/workspaces/execution-store.ts", () => ({
  getExecutionStore: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "node:fs";
import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import {
  assembleWaveBriefing,
  readWaveGuidance,
} from "@features/orchestration/services/wave-briefing.ts";
import type { PromptContext } from "../model/types.ts";
import { injectWaveBriefing } from "../services/inject-wave-briefing.ts";

function makeCtx(
  overrides: Partial<PromptContext> & {
    wave?: number;
    consultation_outputs?: PromptContext["input"]["consultation_outputs"];
    items?: PromptContext["input"]["items"];
    project_dir?: string;
  } = {},
): PromptContext {
  const { wave, consultation_outputs, items, project_dir, ...rest } = overrides;
  return {
    basePrompt: "Base prompt text",
    input: {
      flow: {
        description: "Test",
        entry: "implement",
        name: "test-flow",
        spawn_instructions: { implement: "Do the thing" },
        states: {
          done: { type: "terminal" },
          implement: { agent: "implementor", type: "wave" },
        },
      } as ResolvedFlow,
      state_id: "implement",
      variables: {},
      workspace: "/tmp/test-workspace",
      ...("wave" in overrides ? { wave } : { wave: 2 }),
      ...("consultation_outputs" in overrides ? { consultation_outputs } : {}),
      ...("items" in overrides ? { items } : {}),
      ...("project_dir" in overrides ? { project_dir } : {}),
    },
    mergedVariables: {},
    prompts: [],
    rawInstruction: "Do the thing",
    state: { agent: "implementor", type: "wave" } as StateDefinition,
    warnings: [],
    ...rest,
  };
}

// Default mock implementations for KG-related mocks
function setupDefaultKgMocks() {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(getExecutionStore).mockReturnValue({
    getSession: vi.fn().mockReturnValue({ tier: "medium" }),
  } as unknown as ReturnType<typeof getExecutionStore>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readWaveGuidance).mockResolvedValue("");
  vi.mocked(assembleWaveBriefing).mockReturnValue("");
  setupDefaultKgMocks();
});

// Tests: no-op conditions

describe("injectWaveBriefing — no-op conditions", () => {
  it("returns ctx unchanged when state type is 'single'", async () => {
    const ctx = makeCtx({
      state: { agent: "implementor", type: "single" } as StateDefinition,
      wave: 1,
    });
    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
    expect(readWaveGuidance).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when state type is 'parallel'", async () => {
    const ctx = makeCtx({
      state: { agents: ["implementor"], type: "parallel" } as StateDefinition,
      wave: 1,
    });
    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
  });

  it("returns ctx unchanged when wave is null/undefined", async () => {
    const ctx = makeCtx({
      state: { agent: "implementor", type: "wave" } as StateDefinition,
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
    await injectWaveBriefing(ctx);
    // assembleWaveBriefing should not be called without consultation_outputs
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
  });
});

// Tests: wave briefing injection for wave state

describe("injectWaveBriefing — wave state", () => {
  it("appends wave briefing to basePrompt when consultation_outputs provided", async () => {
    const ctx = makeCtx({
      consultation_outputs: {
        "consult-1": { section: "Architecture Notes", summary: "Use repository pattern" },
      },
      wave: 2,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue(
      "## Wave Briefing\n\nArchitecture Notes: Use repository pattern",
    );

    const result = await injectWaveBriefing(ctx);

    expect(assembleWaveBriefing).toHaveBeenCalledOnce();
    expect(result.basePrompt).toContain("Base prompt text");
    expect(result.basePrompt).toContain("## Wave Briefing");
  });

  it("does not append briefing to basePrompt when assembleWaveBriefing returns empty string", async () => {
    const ctx = makeCtx({
      consultation_outputs: { "consult-1": { summary: "empty" } },
      wave: 2,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toBe("Base prompt text");
  });

  it("passes wave number to assembleWaveBriefing", async () => {
    const ctx = makeCtx({
      consultation_outputs: {
        key: { section: "Sec", summary: "summary text" },
      },
      wave: 3,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    expect(assembleWaveBriefing).toHaveBeenCalledWith(expect.objectContaining({ wave: 3 }));
  });
});

// Tests: wave state with parallel-per

describe("injectWaveBriefing — parallel-per state", () => {
  it("also appends wave briefing for parallel-per state type", async () => {
    const ctx = makeCtx({
      consultation_outputs: { key: { section: "Sec", summary: "text" } },
      state: { agent: "implementor", type: "parallel-per" } as StateDefinition,
      wave: 1,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing\n\nSec: text");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).toContain("## Wave Briefing");
  });
});

// Tests: escaping

describe("injectWaveBriefing — escaping consultation outputs", () => {
  it("escapes ${var} patterns in consultation output summaries before passing to assembleWaveBriefing", async () => {
    const ctx = makeCtx({
      consultation_outputs: {
        key: { section: "Notes", summary: "Use ${variableName} in template" },
      },
      wave: 1,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // The summary passed to assembleWaveBriefing must have escaped ${
    expect(callArg.consultationOutputs.key.summary).toBe("Use \\${variableName} in template");
  });

  it("does not double-escape already-escaped content (no \\\\${ produced)", async () => {
    // The new contract: caller must NOT pre-escape. If they do, this test documents
    // what happens (double-escape). The stage escapes raw text.
    const ctx = makeCtx({
      consultation_outputs: {
        key: { summary: "Raw ${var} text" },
      },
      wave: 1,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // Exactly one escape applied: \${  (not \\${)
    expect(callArg.consultationOutputs.key.summary).toBe("Raw \\${var} text");
    // Must NOT have double-escaped \\${
    expect(callArg.consultationOutputs.key.summary).not.toContain("\\\\${");
  });

  it("escapes ${var} in wave guidance content returned by readWaveGuidance", async () => {
    const ctx = makeCtx({
      consultation_outputs: { key: { summary: "text" } },
      wave: 1,
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
      consultation_outputs: { key: { summary: "text" } },
      wave: 1,
    });
    vi.mocked(readWaveGuidance).mockResolvedValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    const result = await injectWaveBriefing(ctx);
    expect(result.basePrompt).not.toContain("Wave Guidance");
  });

  it("escapes ${var} patterns in section field of consultation outputs", async () => {
    const ctx = makeCtx({
      consultation_outputs: {
        key: { section: "My Section ${title}", summary: "text" },
      },
      wave: 1,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // Section is escaped at the read boundary, same as summary
    expect(callArg.consultationOutputs.key.section).toBe("My Section \\${title}");
  });

  it("preserves section field when it has no ${var} patterns", async () => {
    const ctx = makeCtx({
      consultation_outputs: {
        key: { section: "Architecture Notes", summary: "text" },
      },
      wave: 1,
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    expect(callArg.consultationOutputs.key.section).toBe("Architecture Notes");
  });
});
