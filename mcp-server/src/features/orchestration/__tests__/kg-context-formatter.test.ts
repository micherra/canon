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
 *
 * After the DI refactoring, buildKgFileEntries accepts IKgQuery, IKgStore, and
 * KgInsightMaps as parameters instead of a raw Database handle. Tests construct
 * minimal mock objects satisfying those interfaces — no @graph/ module mocking needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IKgQuery, IKgStore, KgInsightMaps } from "@domains/knowledge-graph/kg-store.interface.ts";
import { buildKgFileEntries, formatKgFileContext } from "../services/kg-context-formatter.ts";

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

/** Build a default KgInsightMaps with empty sets/maps (no hubs, no cycles, no violations). */
function makeEmptyInsightMaps(): KgInsightMaps {
  return {
    cycleMemberPaths: new Map<string, string[]>(),
    hubPaths: new Set<string>(),
    layerViolationsByPath: new Map(),
  };
}

/** Build a minimal IKgQuery mock with controllable return values. */
function makeKgQuery(
  getFileMetrics: ReturnType<typeof vi.fn> = vi.fn(),
): IKgQuery {
  return {
    computeInsightMaps: vi.fn().mockReturnValue(makeEmptyInsightMaps()),
    getAllDegrees: vi.fn(),
    getAllFileDegrees: vi.fn().mockReturnValue(new Map()),
    getAllFilesWithStats: vi.fn().mockReturnValue([]),
    getFileMetrics,
    getKgFreshnessMs: vi.fn().mockReturnValue(1000),
  } as unknown as IKgQuery;
}

/** Build a minimal IKgStore mock with controllable return values. */
function makeKgStore(
  getFile: ReturnType<typeof vi.fn> = vi.fn(),
  getSummaryByFile: ReturnType<typeof vi.fn> = vi.fn(),
): IKgStore {
  return {
    getFile: getFile as IKgStore["getFile"],
    getSummaryByFile: getSummaryByFile as IKgStore["getSummaryByFile"],
  };
}

describe("buildKgFileEntries", () => {
  let mockGetFileMetrics: ReturnType<typeof vi.fn>;
  let mockGetFile: ReturnType<typeof vi.fn>;
  let mockGetSummaryByFile: ReturnType<typeof vi.fn>;
  let kgQuery: IKgQuery;
  let kgStore: IKgStore;
  let insightMaps: KgInsightMaps;

  beforeEach(() => {
    mockGetFileMetrics = vi.fn();
    mockGetFile = vi.fn();
    mockGetSummaryByFile = vi.fn();
    kgQuery = makeKgQuery(mockGetFileMetrics);
    kgStore = makeKgStore(mockGetFile, mockGetSummaryByFile);
    insightMaps = makeEmptyInsightMaps();
  });

  it("returns entries with correct fields for files found in KG", () => {
    const metrics = makeMetrics({ in_degree: 5, is_hub: true, layer: "api", out_degree: 3 });
    mockGetFileMetrics.mockReturnValue(metrics);
    mockGetFile.mockReturnValue({ file_id: 1, path: "src/api/handler.ts" });
    mockGetSummaryByFile.mockReturnValue({ summary: "Handles HTTP requests" });

    const entries = buildKgFileEntries(["src/api/handler.ts"], kgQuery, kgStore, insightMaps);

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

    const entries = buildKgFileEntries(
      ["src/domain/svc.ts", "src/infra/repo.ts"],
      kgQuery,
      kgStore,
      insightMaps,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].layer).toBe("domain");
    expect(entries[0].summary).toBe("Domain logic");
    expect(entries[1].layer).toBe("infra");
    expect(entries[1].summary).toBeNull();
  });

  it("returns entries with unknown layer and 0 degrees for files not in KG", () => {
    mockGetFileMetrics.mockReturnValue(null); // not indexed

    const entries = buildKgFileEntries(["src/unknown/file.ts"], kgQuery, kgStore, insightMaps);

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

  it("passes insightMaps fields into getFileMetrics options", () => {
    const hubPaths = new Set(["src/api/handler.ts"]);
    const cycleMemberPaths = new Map([["src/a.ts", ["src/b.ts"]]]);
    const layerViolationsByPath = new Map();
    const customInsightMaps: KgInsightMaps = { cycleMemberPaths, hubPaths, layerViolationsByPath };

    mockGetFileMetrics.mockReturnValue(makeMetrics());
    mockGetFile.mockReturnValue(undefined);

    buildKgFileEntries(["src/api/handler.ts"], kgQuery, kgStore, customInsightMaps);

    expect(mockGetFileMetrics).toHaveBeenCalledWith("src/api/handler.ts", {
      cycleMemberPaths,
      hubPaths,
      layerViolationsByPath,
    });
  });

  it("returns null summary when no file row found in KG store", () => {
    mockGetFileMetrics.mockReturnValue(makeMetrics());
    mockGetFile.mockReturnValue(undefined); // file not in store

    const entries = buildKgFileEntries(["src/no-store.ts"], kgQuery, kgStore, insightMaps);

    expect(entries[0].summary).toBeNull();
  });

  it("processes all file paths and returns entries in the same order", () => {
    mockGetFileMetrics.mockReturnValue(makeMetrics());
    mockGetFile.mockReturnValue(undefined);

    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const entries = buildKgFileEntries(paths, kgQuery, kgStore, insightMaps);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.path)).toEqual(paths);
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
