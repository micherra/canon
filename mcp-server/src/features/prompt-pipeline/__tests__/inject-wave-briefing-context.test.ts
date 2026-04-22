/**
 * Tests for inject-wave-briefing.ts (Stage 6) — Part 2
 *
 * Covers:
 * - KG summary injection for file items (ADR-008)
 * - Graceful degradation when KG DB unavailable
 * - Tier-based item count cap
 * - Staleness warning at 1-hour threshold
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

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
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
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  assembleWaveBriefing,
  readWaveGuidance,
} from "@features/orchestration/services/wave-briefing.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
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

// Tests: KG summary injection (ADR-008)

describe("injectWaveBriefing — KG summary injection", () => {
  function makeMockKgQuery(
    overrides: {
      getFileMetrics?: ReturnType<typeof vi.fn>;
      getKgFreshnessMs?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    return {
      getFileMetrics: overrides.getFileMetrics ?? vi.fn().mockReturnValue(null),
      getKgFreshnessMs: overrides.getKgFreshnessMs ?? vi.fn().mockReturnValue(1000),
    };
  }

  function makeMockKgStore(summaryText: string | null = "A summary of the file") {
    return {
      getFile: vi.fn().mockReturnValue({ file_id: 42, mtime_ms: 0, path: "src/tools/my-tool.ts" }),
      getSummaryByFile: vi
        .fn()
        .mockReturnValue(summaryText !== null ? { summary: summaryText } : undefined),
    };
  }

  function setupKgMocks(
    options: {
      dbExists?: boolean;
      tier?: "small" | "medium" | "large";
      fileMetrics?: ReturnType<typeof vi.fn>;
      kgFreshnessMs?: number | null;
      summaryText?: string | null;
    } = {},
  ) {
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
        cycleMemberPaths: new Map(),
        hubPaths: new Set(),
        layerViolationsByPath: new Map(),
      });

      const defaultMetrics = {
        cycle_peers: [],
        impact_score: 17,
        in_cycle: false,
        in_degree: 5,
        is_hub: false,
        layer: "domain",
        layer_violation_count: 0,
        layer_violations: [],
        out_degree: 3,
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
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("### File Context");
    expect(result.basePrompt).toContain("src/tools/my-tool.ts");
    expect(result.basePrompt).toContain("layer: domain");
    expect(result.basePrompt).toContain("in_degree: 5");
    expect(result.basePrompt).toContain("out_degree: 3");
    expect(result.basePrompt).toContain("A summary of the file");
  });

  it("skips KG injection when no items are provided", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
    // DB should not even be opened
    expect(initDatabase).not.toHaveBeenCalled();
  });

  it("skips KG injection when items array is empty", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      items: [],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
  });

  it("emits warning and skips injection when KG DB is unavailable", async () => {
    setupKgMocks({ dbExists: false });
    const ctx = makeCtx({
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
    expect(
      result.warnings.some(
        (w) => w.includes("KG") || w.includes("knowledge") || w.includes("not indexed"),
      ),
    ).toBe(true);
  });

  it("emits staleness warning when KG freshness exceeds 1 hour threshold", async () => {
    const OVER_ONE_HOUR = 3_700_000;
    setupKgMocks({ kgFreshnessMs: OVER_ONE_HOUR });
    const ctx = makeCtx({
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    // Injection still proceeds
    expect(result.basePrompt).toContain("File Context");
    // Warning is emitted
    expect(
      result.warnings.some(
        (w) =>
          w.toLowerCase().includes("stale") ||
          w.includes("1hr") ||
          w.includes("hour") ||
          w.includes(">1"),
      ),
    ).toBe(true);
  });

  it("does not emit staleness warning when KG freshness is within 1 hour", async () => {
    const UNDER_ONE_HOUR = 1_800_000; // 30 minutes
    setupKgMocks({ kgFreshnessMs: UNDER_ONE_HOUR });
    const ctx = makeCtx({
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.warnings.some((w) => w.toLowerCase().includes("stale"))).toBe(false);
  });

  it("respects tier-based item count cap — medium tier caps at 15", async () => {
    setupKgMocks({ tier: "medium" });
    const manyItems = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    const ctx = makeCtx({
      items: manyItems,
      project_dir: "/project",
      wave: 1,
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
      items: manyItems,
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    const matches = (result.basePrompt.match(/src\/file-/g) || []).length;
    expect(matches).toBeLessThanOrEqual(5);
    expect(matches).toBeGreaterThan(0);
  });

  it("extracts file paths from object items with 'files' field", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      items: [{ files: ["src/tools/my-tool.ts", "src/utils/helper.ts"] }],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("### File Context");
  });

  it("extracts file paths from object items with 'affected_files' field", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      items: [{ affected_files: ["src/tools/my-tool.ts"] }],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).toContain("### File Context");
  });

  it("calls computeFileInsightMaps exactly once (not per file) — prevents N+1", async () => {
    setupKgMocks();
    const ctx = makeCtx({
      items: ["src/file-a.ts", "src/file-b.ts", "src/file-c.ts"],
      project_dir: "/project",
      wave: 1,
    });

    await injectWaveBriefing(ctx);

    expect(computeFileInsightMaps).toHaveBeenCalledOnce();
  });

  it("escapes ${var} patterns in KG section via escapeDollarBrace at trust boundary", async () => {
    setupKgMocks({ summaryText: "Uses ${TEMPLATE_VAR} for injection" });
    const ctx = makeCtx({
      items: ["src/tools/my-tool.ts"],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    // The KG section text must have escaped ${ patterns
    expect(result.basePrompt).toContain("\\${TEMPLATE_VAR}");
    expect(result.basePrompt).not.toContain("Uses ${TEMPLATE_VAR}");
  });

  it("handles file not in KG DB gracefully — skips that file, no crash", async () => {
    setupKgMocks({ fileMetrics: vi.fn().mockReturnValue(null) });
    const ctx = makeCtx({
      items: ["src/tools/unknown-file.ts"],
      project_dir: "/project",
      wave: 1,
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
      items: [{ description: "No files here", task: "Do something" }],
      project_dir: "/project",
      wave: 1,
    });

    const result = await injectWaveBriefing(ctx);

    expect(result.basePrompt).not.toContain("File Context");
  });
});
