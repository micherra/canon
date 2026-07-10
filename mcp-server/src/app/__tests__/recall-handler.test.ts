import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// --- Mocks ---
// Mock server-state first so no MCP server is instantiated during tests.
vi.mock("@app/server-state.ts", () => ({
  pluginDir: "/mock/plugin",
  resolveScope: () => "/mock/project",
}));

vi.mock("@features/knowledge-graph/tools/semantic-search.ts", () => ({
  semanticSearch: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/search-knowledge.ts", () => ({
  searchKnowledge: vi.fn(),
}));
vi.mock("@features/orchestration/tools/get-decisions-corpus.ts", () => ({
  getDecisionsCorpus: vi.fn(),
}));
vi.mock("@features/history/tools/get-build-history.ts", () => ({
  getBuildHistory: vi.fn(),
}));
vi.mock("../recall-adr-source.ts", () => ({
  rankAdrs: vi.fn(),
}));

// Import after mocks are set up.
import { getBuildHistory } from "@features/history/tools/get-build-history.ts";
import { searchKnowledge } from "@features/knowledge-graph/tools/search-knowledge.ts";
import { semanticSearch } from "@features/knowledge-graph/tools/semantic-search.ts";
import { getDecisionsCorpus } from "@features/orchestration/tools/get-decisions-corpus.ts";
import { rankAdrs } from "../recall-adr-source.ts";
import { handleRecall, recallInputSchema } from "../recall-handler.ts";

function okSemanticSearch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    count: 1,
    ok: true as const,
    query: "q",
    results: [
      {
        distance: 0.1,
        entity_id: 1,
        file_id: 1,
        file_path: "src/foo.ts",
        kind: "function" as const,
        name: "foo",
        qualified_name: "foo",
        source: "entity" as const,
      },
    ],
    ...overrides,
  };
}

function okSearchKnowledge() {
  return {
    count: 1,
    ok: true as const,
    query: "q",
    results: [
      {
        chunk_id: 1,
        chunk_index: 0,
        content: "principle body content",
        corpus: "principles",
        distance: 0.2,
        doc_path: "principles/foo.md",
        heading_path: "Foo",
        trust_tier: "internal",
      },
    ],
  };
}

function okDecisionsCorpus() {
  return {
    aggregation: {
      by_category: {},
      by_decision_type: {},
      by_outcome: {},
      fill_rates: { gate: 1, outcome: 1, rationale: 1, refs: 1 },
      total: 1,
    },
    decisions: [
      {
        decided_at: "2026-01-01T00:00:00.000Z",
        decision_type: "plan_approval",
        rationale: "because durable",
        source: "live" as const,
        source_event_id: 42,
        source_slug: "some-build",
        summary: "durable decisions corpus decision",
      },
    ],
    ok: true as const,
    rendered: "",
    skipped: [],
  };
}

function okBuildHistory() {
  return {
    archives: [
      {
        archive_id: "abc123",
        archive_path: "/archive/abc123",
        archived_at: "2026-01-01T00:00:00.000Z",
        artifact_types: [],
        branch: "canon/durable-decisions",
        flow: "feature",
        has_run_summary: true,
        sanitized_branch: "canon-durable-decisions",
        slug: "durable-decisions",
        source_run_id: null,
        task: "durable decisions build",
        tier: "medium",
      },
    ],
    ok: true as const,
    total_count: 1,
  };
}

function okAdrCandidates() {
  return [
    {
      id: "adr:ADR-0040",
      native_score: 2,
      path: "docs/adr/0040-durable.md",
      snippet: "Durable decisions corpus — ...",
      source_store: "adr" as const,
    },
  ];
}

describe("handleRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(semanticSearch).mockResolvedValue(okSemanticSearch());
    vi.mocked(searchKnowledge).mockResolvedValue(okSearchKnowledge());
    vi.mocked(getDecisionsCorpus).mockResolvedValue(okDecisionsCorpus());
    vi.mocked(getBuildHistory).mockResolvedValue(okBuildHistory());
    vi.mocked(rankAdrs).mockReturnValue(okAdrCandidates());
  });

  it("returns a fused result spanning >=3 distinct source_store values, descending rrf_score, full provenance", async () => {
    const output = await handleRecall({ query: "durable decisions corpus" });

    const stores = new Set(output.hits.map((h) => h.source_store));
    expect(stores.size).toBeGreaterThanOrEqual(3);

    for (let i = 1; i < output.hits.length; i++) {
      expect(output.hits[i - 1].rrf_score).toBeGreaterThanOrEqual(output.hits[i].rrf_score);
    }

    for (const hit of output.hits) {
      expect(hit).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          native_rank: expect.any(Number),
          rrf_score: expect.any(Number),
          snippet: expect.any(String),
          source_store: expect.any(String),
        }),
      );
    }

    expect(output.skipped).toEqual([]);
  });

  it("is per-store fail-open — one adapter throwing still yields a non-empty result with the failed store in skipped[]", async () => {
    vi.mocked(semanticSearch).mockRejectedValue(new Error("kg boom"));

    const output = await handleRecall({ query: "durable decisions corpus" });

    expect(output.hits.length).toBeGreaterThan(0);
    expect(output.skipped).toEqual([expect.objectContaining({ store: "code_kg" })]);
    // The other stores still contributed.
    expect(output.hits.some((h) => h.source_store === "adr")).toBe(true);
  });

  it("restricts fan-out to the requested stores filter", async () => {
    const output = await handleRecall({ query: "durable decisions corpus", stores: ["adr"] });

    expect(semanticSearch).not.toHaveBeenCalled();
    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(getDecisionsCorpus).not.toHaveBeenCalled();
    expect(getBuildHistory).not.toHaveBeenCalled();
    expect(output.hits.every((h) => h.source_store === "adr")).toBe(true);
  });

  it("caps fused hits at limit", async () => {
    const output = await handleRecall({ limit: 1, query: "durable decisions corpus" });
    expect(output.hits.length).toBeLessThanOrEqual(1);
  });

  it("rejects an empty query via the input schema", () => {
    const parsed = z.object(recallInputSchema).safeParse({ query: "" });
    expect(parsed.success).toBe(false);
  });
});
