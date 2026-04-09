/**
 * Tests for kg-context-formatter.ts
 *
 * Covers:
 * - buildKgFileEntries with files in KG → correct fields
 * - buildKgFileEntries with files not in KG → unknown layer, 0 degrees, indexed: false
 * - formatKgFileContext produces expected markdown with hub label yes/no
 * - formatKgFileContext with empty entries returns empty string
 * - formatKgFileContext with custom heading uses that heading
 * - Unindexed file contains "(not indexed)"
 * - formatKgFileContext default heading includes file count
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

const {
  mockGetFileMetrics,
  mockGetKgFreshnessMs,
  mockGetFile,
  mockGetSummaryByFile,
  mockComputeFileInsightMaps,
} = vi.hoisted(() => {
  const mockGetFileMetrics = vi.fn();
  const mockGetKgFreshnessMs = vi.fn().mockReturnValue(1000);
  const mockGetFile = vi.fn();
  const mockGetSummaryByFile = vi.fn();
  const mockComputeFileInsightMaps = vi.fn().mockReturnValue({
    cycleMemberPaths: new Map<string, string[]>(),
    hubPaths: new Set<string>(),
    layerViolationsByPath: new Map(),
  });
  return {
    mockComputeFileInsightMaps,
    mockGetFile,
    mockGetFileMetrics,
    mockGetKgFreshnessMs,
    mockGetSummaryByFile,
  };
});

vi.mock("@graph/kg-query-insights.ts", () => ({
  computeFileInsightMaps: mockComputeFileInsightMaps,
}));

vi.mock("@graph/kg-query.ts", () => ({
  KgQuery: class MockKgQuery {
    getFileMetrics = mockGetFileMetrics;
    getKgFreshnessMs = mockGetKgFreshnessMs;
  },
}));

vi.mock("@graph/kg-store.ts", () => ({
  KgStore: class MockKgStore {
    getFile = mockGetFile;
    getSummaryByFile = mockGetSummaryByFile;
  },
}));

import { buildKgFileEntries, formatKgFileContext } from "../services/kg-context-formatter.ts";

// Minimal mock DB (only needs to be passed through; never called directly in the module)
const mockDb = {} as Parameters<typeof buildKgFileEntries>[1];

// Shared metrics shape matching FileMetrics
function makeMetrics(
  overrides: { in_degree?: number; out_degree?: number; is_hub?: boolean; layer?: string } = {},
) {
  return {
    cycle_peers: [],
    impact_score: 10,
    in_cycle: false,
    in_degree: overrides.in_degree ?? 3,
    is_hub: overrides.is_hub ?? false,
    layer: overrides.layer ?? "domain",
    layer_violation_count: 0,
    layer_violations: [],
    out_degree: overrides.out_degree ?? 2,
  };
}

describe("buildKgFileEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeFileInsightMaps.mockReturnValue({
      cycleMemberPaths: new Map<string, string[]>(),
      hubPaths: new Set<string>(),
      layerViolationsByPath: new Map(),
    });
  });

  it("returns entries with correct fields for files found in KG", () => {
    const metrics = makeMetrics({ in_degree: 5, is_hub: true, layer: "api", out_degree: 3 });
    mockGetFileMetrics.mockReturnValue(metrics);
    mockGetFile.mockReturnValue({ file_id: 1, path: "src/api/handler.ts" });
    mockGetSummaryByFile.mockReturnValue({ summary: "Handles HTTP requests" });

    const entries = buildKgFileEntries(["src/api/handler.ts"], mockDb);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.path).toBe("src/api/handler.ts");
    expect(entry.layer).toBe("api");
    expect(entry.inDegree).toBe(5);
    expect(entry.outDegree).toBe(3);
    expect(entry.isHub).toBe(true);
    expect(entry.summary).toBe("Handles HTTP requests");
    expect(entry.indexed).toBe(true);
  });

  it("returns entries with correct fields for multiple files", () => {
    mockGetFileMetrics
      .mockReturnValueOnce(makeMetrics({ in_degree: 2, layer: "domain", out_degree: 4 }))
      .mockReturnValueOnce(makeMetrics({ in_degree: 0, layer: "infra", out_degree: 1 }));
    mockGetFile.mockReturnValueOnce({ file_id: 10 }).mockReturnValueOnce({ file_id: 11 });
    mockGetSummaryByFile
      .mockReturnValueOnce({ summary: "Domain logic" })
      .mockReturnValueOnce(undefined);

    const entries = buildKgFileEntries(["src/domain/svc.ts", "src/infra/repo.ts"], mockDb);

    expect(entries).toHaveLength(2);
    expect(entries[0].layer).toBe("domain");
    expect(entries[0].summary).toBe("Domain logic");
    expect(entries[1].layer).toBe("infra");
    expect(entries[1].summary).toBeNull();
  });

  it("returns entries with unknown layer and 0 degrees for files not in KG", () => {
    mockGetFileMetrics.mockReturnValue(null); // not indexed

    const entries = buildKgFileEntries(["src/unknown/file.ts"], mockDb);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.path).toBe("src/unknown/file.ts");
    expect(entry.layer).toBe("unknown");
    expect(entry.inDegree).toBe(0);
    expect(entry.outDegree).toBe(0);
    expect(entry.isHub).toBe(false);
    expect(entry.summary).toBeNull();
    expect(entry.indexed).toBe(false);
  });

  it("calls computeFileInsightMaps exactly once (not per file) — prevents N+1", () => {
    mockGetFileMetrics.mockReturnValue(makeMetrics());
    mockGetFile.mockReturnValue(undefined);

    buildKgFileEntries(["src/a.ts", "src/b.ts", "src/c.ts"], mockDb);

    expect(mockComputeFileInsightMaps).toHaveBeenCalledTimes(1);
  });

  it("returns null summary when no file row found in KG store", () => {
    mockGetFileMetrics.mockReturnValue(makeMetrics());
    mockGetFile.mockReturnValue(undefined); // file not in store

    const entries = buildKgFileEntries(["src/no-store.ts"], mockDb);

    expect(entries[0].summary).toBeNull();
  });
});

describe("formatKgFileContext", () => {
  it("returns empty string for empty entries array", () => {
    expect(formatKgFileContext([])).toBe("");
  });

  it("produces markdown with hub label yes for hub files", () => {
    const entries = [
      {
        inDegree: 8,
        indexed: true,
        isHub: true,
        layer: "shared",
        outDegree: 5,
        path: "src/shared/utils.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("src/shared/utils.ts");
    expect(result).toContain("hub: yes");
    expect(result).toContain("layer: shared");
    expect(result).toContain("in_degree: 8");
    expect(result).toContain("out_degree: 5");
  });

  it("produces markdown with hub label no for non-hub files", () => {
    const entries = [
      {
        inDegree: 1,
        indexed: true,
        isHub: false,
        layer: "domain",
        outDegree: 2,
        path: "src/domain/service.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("hub: no");
  });

  it("includes summary line when summary is non-null", () => {
    const entries = [
      {
        inDegree: 2,
        indexed: true,
        isHub: false,
        layer: "api",
        outDegree: 1,
        path: "src/api/router.ts",
        summary: "Routes HTTP requests to handlers",
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("Summary: Routes HTTP requests to handlers");
  });

  it("does not include summary line when summary is null", () => {
    const entries = [
      {
        inDegree: 2,
        indexed: true,
        isHub: false,
        layer: "api",
        outDegree: 1,
        path: "src/api/router.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).not.toContain("Summary:");
  });

  it("contains (not indexed) for unindexed files", () => {
    const entries = [
      {
        inDegree: 0,
        indexed: false,
        isHub: false,
        layer: "unknown",
        outDegree: 0,
        path: "src/new/untracked.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("src/new/untracked.ts");
    expect(result).toContain("(not indexed)");
  });

  it("uses default heading with file count when heading not provided", () => {
    const entries = [
      {
        inDegree: 1,
        indexed: true,
        isHub: false,
        layer: "domain",
        outDegree: 1,
        path: "src/domain/entity.ts",
        summary: null,
      },
      {
        inDegree: 2,
        indexed: true,
        isHub: false,
        layer: "api",
        outDegree: 3,
        path: "src/api/handler.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("### File Context (2 files)");
  });

  it("uses custom heading when heading parameter is provided", () => {
    const entries = [
      {
        inDegree: 1,
        indexed: true,
        isHub: false,
        layer: "domain",
        outDegree: 1,
        path: "src/domain/entity.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries, "## My Custom Heading");

    expect(result).toContain("## My Custom Heading");
    expect(result).not.toContain("### File Context");
  });

  it("returns raw (unescaped) text — does not escape dollar-brace patterns", () => {
    const entries = [
      {
        inDegree: 1,
        indexed: true,
        isHub: false,
        layer: "domain",
        outDegree: 1,
        path: "src/domain/entity.ts",
        summary: "Uses ${TEMPLATE_VAR} for injection",
      },
    ];

    const result = formatKgFileContext(entries);

    // Raw text — no escaping applied here
    expect(result).toContain("${TEMPLATE_VAR}");
    expect(result).not.toContain("\\${TEMPLATE_VAR}");
  });

  it("handles mix of indexed and unindexed files", () => {
    const entries = [
      {
        inDegree: 3,
        indexed: true,
        isHub: false,
        layer: "api",
        outDegree: 2,
        path: "src/api/handler.ts",
        summary: "API handler",
      },
      {
        inDegree: 0,
        indexed: false,
        isHub: false,
        layer: "unknown",
        outDegree: 0,
        path: "src/new/untracked.ts",
        summary: null,
      },
    ];

    const result = formatKgFileContext(entries);

    expect(result).toContain("src/api/handler.ts");
    expect(result).toContain("hub: no");
    expect(result).toContain("src/new/untracked.ts");
    expect(result).toContain("(not indexed)");
  });
});
