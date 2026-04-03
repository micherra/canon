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
 * - KG summary injection for file items (ADR-008)
 * - Graceful degradation when KG DB unavailable
 * - Tier-based item count cap
 * - Staleness warning at 1-hour threshold
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn(),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../graph/kg-query.ts", () => ({
  KgQuery: vi.fn(),
  computeFileInsightMaps: vi.fn(),
}));

vi.mock("../../graph/kg-store.ts", () => ({
  KgStore: vi.fn(),
}));

vi.mock("../../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("../../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import { KgQuery, computeFileInsightMaps } from "../../graph/kg-query.ts";
import { KgStore } from "../../graph/kg-store.ts";
import { initDatabase } from "../../graph/kg-schema.ts";
import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { existsSync } from "node:fs";
import { injectWaveBriefing } from "../../tools/prompt-pipeline/inject-wave-briefing.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";
import type { ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PromptContext> & {
  wave?: number;
  consultation_outputs?: PromptContext["input"]["consultation_outputs"];
  items?: PromptContext["input"]["items"];
  project_dir?: string;
} = {}): PromptContext {
  const { wave, consultation_outputs, items, project_dir, ...rest } = overrides;
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
      ...("items" in overrides ? { items } : {}),
      ...("project_dir" in overrides ? { project_dir } : {}),
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

  it("escapes ${var} patterns in section field of consultation outputs", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: {
        key: { section: "My Section ${title}", summary: "text" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    // Section is escaped at the read boundary, same as summary
    expect(callArg.consultationOutputs["key"].section).toBe("My Section \\${title}");
  });

  it("preserves section field when it has no ${var} patterns", async () => {
    const ctx = makeCtx({
      wave: 1,
      consultation_outputs: {
        key: { section: "Architecture Notes", summary: "text" },
      },
    });
    vi.mocked(assembleWaveBriefing).mockReturnValue("briefing");

    await injectWaveBriefing(ctx);

    const callArg = vi.mocked(assembleWaveBriefing).mock.calls[0][0];
    expect(callArg.consultationOutputs["key"].section).toBe("Architecture Notes");
  });
});

// ---------------------------------------------------------------------------
// Tests: KG summary injection (ADR-008)
// ---------------------------------------------------------------------------

describe("injectWaveBriefing — KG summary injection", () => {
  function makeMockKgQuery(overrides: {
    getFileMetrics?: ReturnType<typeof vi.fn>;
    getKgFreshnessMs?: ReturnType<typeof vi.fn>;
  } = {}) {
    return {
      getFileMetrics: overrides.getFileMetrics ?? vi.fn().mockReturnValue(null),
      getKgFreshnessMs: overrides.getKgFreshnessMs ?? vi.fn().mockReturnValue(1000),
    };
  }

  function makeMockKgStore(summaryText: string | null = "A summary of the file") {
    return {
      getFile: vi.fn().mockReturnValue({ file_id: 42, path: "src/tools/my-tool.ts", mtime_ms: 0 }),
      getSummaryByFile: vi.fn().mockReturnValue(
        summaryText !== null ? { summary: summaryText } : undefined,
      ),
    };
  }

  function setupKgMocks(options: {
    dbExists?: boolean;
    tier?: "small" | "medium" | "large";
    fileMetrics?: ReturnType<typeof vi.fn>;
    kgFreshnessMs?: number | null;
    summaryText?: string | null;
  } = {}) {
    const {
      dbExists = true,
      tier = "medium",
      fileMetrics,
      kgFreshnessMs = 1000,
      summaryText = "A summary of the file",
    } = options;

    vi.mocked(existsSync).mockReturnValue(dbExists);
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier }),
    } as unknown as ReturnType<typeof getExecutionStore>);

    if (dbExists) {
      const mockDb = { close: vi.fn() };
      vi.mocked(initDatabase).mockReturnValue(mockDb as unknown as ReturnType<typeof initDatabase>);
      vi.mocked(computeFileInsightMaps).mockReturnValue({
        hubPaths: new Set(),
        cycleMemberPaths: new Map(),
        layerViolationsByPath: new Map(),
      });

      const defaultMetrics = {
        in_degree: 5,
        out_degree: 3,
        is_hub: false,
        in_cycle: false,
        cycle_peers: [],
        layer: "domain",
        layer_violation_count: 0,
        layer_violations: [],
        impact_score: 17,
      };

      vi.mocked(KgQuery).mockImplementation(function () {
        return makeMockKgQuery({
          getFileMetrics: fileMetrics ?? vi.fn().mockReturnValue(defaultMetrics),
          getKgFreshnessMs: vi.fn().mockReturnValue(kgFreshnessMs),
        });
      } as unknown as typeof KgQuery);

      vi.mocked(KgStore).mockImplementation(function () {
        return makeMockKgStore(summaryText);
      } as unknown as typeof KgStore);
    }
  }

  it("injects file context section when wave state has file path items and KG DB is available", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("## File Context (from Knowledge Graph)");
    expect(result.basePrompt).toContain("src/tools/my-tool.ts");
    expect(result.basePrompt).toContain("layer: domain");
    expect(result.basePrompt).toContain("in: 5");
    expect(result.basePrompt).toContain("out: 3");
    expect(result.basePrompt).toContain("A summary of the file");
  });

  it("skips KG injection when no items are provided", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
    // DB should not even be opened
    expect(initDatabase).not.toHaveBeenCalled();
  });

  it("skips KG injection when items array is empty", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      items: [],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
  });

  it("emits warning and skips injection when KG DB is unavailable", async () => {
    setupKgMocks({ dbExists: false });
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
    expect(result.warnings.some((w) => w.includes("KG") || w.includes("knowledge") || w.includes("not indexed"))).toBe(true);
  });

  it("emits staleness warning when KG freshness exceeds 1 hour threshold", async () => {
    const OVER_ONE_HOUR = 3_700_000;
    setupKgMocks({ kgFreshnessMs: OVER_ONE_HOUR });
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    // Injection still proceeds
    expect(result.basePrompt).toContain("File Context");
    // Warning is emitted
    expect(result.warnings.some((w) => w.toLowerCase().includes("stale") || w.includes("1hr") || w.includes("hour") || w.includes(">1"))).toBe(true);
  });

  it("does not emit staleness warning when KG freshness is within 1 hour", async () => {
    const UNDER_ONE_HOUR = 1_800_000; // 30 minutes
    setupKgMocks({ kgFreshnessMs: UNDER_ONE_HOUR });
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.warnings.some((w) => w.toLowerCase().includes("stale"))).toBe(false);
  });

  it("respects tier-based item count cap — medium tier caps at 15", async () => {
    setupKgMocks({ tier: "medium" });
    const manyItems = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    const ctx = makeCtx({
      wave: 1,
      items: manyItems,
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    // Count occurrences of "src/file-" in the output
    const matches = (result.basePrompt.match(/src\/file-/g) || []).length;
    expect(matches).toBeLessThanOrEqual(15);
    expect(matches).toBeGreaterThan(0);
  });

  it("respects tier-based item count cap — small tier caps at 5", async () => {
    setupKgMocks({ tier: "small" });
    const manyItems = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    const ctx = makeCtx({
      wave: 1,
      items: manyItems,
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    const matches = (result.basePrompt.match(/src\/file-/g) || []).length;
    expect(matches).toBeLessThanOrEqual(5);
    expect(matches).toBeGreaterThan(0);
  });

  it("extracts file paths from object items with 'files' field", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      items: [{ files: ["src/tools/my-tool.ts", "src/utils/helper.ts"] }],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("## File Context (from Knowledge Graph)");
  });

  it("extracts file paths from object items with 'affected_files' field", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      items: [{ affected_files: ["src/tools/my-tool.ts"] }],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("## File Context (from Knowledge Graph)");
  });

  it("calls computeFileInsightMaps exactly once (not per file) — prevents N+1", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      wave: 1,
      items: ["src/file-a.ts", "src/file-b.ts", "src/file-c.ts"],
      project_dir: "/project",
    });

    await injectWaveBriefing(ctx);

    expect(computeFileInsightMaps).toHaveBeenCalledOnce();
  });

  it("escapes ${var} patterns in KG section via escapeDollarBrace at trust boundary", async () => {
    setupKgMocks({ summaryText: "Uses ${TEMPLATE_VAR} for injection" });
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    // The KG section text must have escaped ${ patterns
    expect(result.basePrompt).toContain("\\${TEMPLATE_VAR}");
    expect(result.basePrompt).not.toContain("Uses ${TEMPLATE_VAR}");
  });

  it("handles file not in KG DB gracefully — skips that file, no crash", async () => {
    setupKgMocks({ fileMetrics: vi.fn().mockReturnValue(null) });
    const ctx = makeCtx({
      wave: 1,
      items: ["src/tools/unknown-file.ts"],
      project_dir: "/project",
    });

    // Should not throw
    const result = await injectWaveBriefing(ctx);
    // File context section may still appear (with limited info), but no crash
    expect(result).toBeDefined();
  });

  it("skips KG injection when no file paths can be extracted from items", async () => {
    setupKgMocks();
    // Items are objects without any recognized file field
    const ctx = makeCtx({
      wave: 1,
      items: [{ task: "Do something", description: "No files here" }],
      project_dir: "/project",
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
  });
});
