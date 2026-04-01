/**
 * Tests for graph-query.ts — ToolResult<T> migration
 *
 * Covers:
 * - KG_NOT_INDEXED when DB file is absent (recoverable: true)
 * - INVALID_INPUT when target is missing for query types that require it
 * - Successful query returns { ok: true, query_type, results, count }
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// We must mock the DB layer so we don't need a real SQLite file
// ---------------------------------------------------------------------------

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn().mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), get: vi.fn() }),
  }),
}));

vi.mock("../graph/kg-query.ts", () => ({
  KgQuery: vi.fn(function () {
    return {
      search: vi.fn().mockReturnValue([]),
      findDeadCode: vi.fn().mockReturnValue([{ entity_id: 1, name: "orphan", kind: "function" }]),
      getCallers: vi.fn().mockReturnValue([{ entity_id: 2, name: "caller", kind: "function" }]),
      getCallees: vi.fn().mockReturnValue([{ entity_id: 3, name: "callee", kind: "function" }]),
      getBlastRadius: vi.fn().mockReturnValue([{ entity_id: 4, name: "dep", depth: 1 }]),
      getAncestors: vi.fn().mockReturnValue([{ entity_id: 5, name: "ancestor", depth: 1 }]),
    };
  }),
}));

import { graphQuery } from "../tools/graph-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgQuery } from "../graph/kg-query.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "graph-query-test-"));
  await mkdir(join(tmpDir, ".canon"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("graphQuery — KG_NOT_INDEXED", () => {
  it("returns KG_NOT_INDEXED when DB file does not exist", () => {
    // DB file NOT created — existsSync returns false
    const result = graphQuery(
      { query_type: "search", target: "myFunc" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("KG_NOT_INDEXED");
      expect(result.recoverable).toBe(true);
      expect(result.message).toContain("codebase_graph");
    }
  });
});

describe("graphQuery — INVALID_INPUT for missing target", () => {
  beforeEach(async () => {
    // Create the DB file so existsSync passes
    await writeFile(join(tmpDir, ".canon", "knowledge-graph.db"), "");
  });

  it("returns INVALID_INPUT when target is missing for 'search' query type", () => {
    const result = graphQuery(
      { query_type: "search" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("search");
    }
  });

  it("returns INVALID_INPUT when target is missing for 'callers' query type", () => {
    const result = graphQuery(
      { query_type: "callers" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("callers");
    }
  });

  it("returns INVALID_INPUT when target is missing for 'callees' query type", () => {
    const result = graphQuery(
      { query_type: "callees" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("callees");
    }
  });

  it("returns INVALID_INPUT when target is missing for 'blast_radius' query type", () => {
    const result = graphQuery(
      { query_type: "blast_radius" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("blast_radius");
    }
  });

  it("returns INVALID_INPUT when target is missing for 'ancestors' query type", () => {
    const result = graphQuery(
      { query_type: "ancestors" },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("ancestors");
    }
  });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("graphQuery — success cases", () => {
  beforeEach(async () => {
    // Create the DB file so existsSync passes
    await writeFile(join(tmpDir, ".canon", "knowledge-graph.db"), "");
  });

  it("returns ok: true with query_type, results, count for 'dead_code'", () => {
    const result = graphQuery(
      { query_type: "dead_code" },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query_type).toBe("dead_code");
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.count).toBe("number");
    expect(result.count).toBe(result.results.length);
  });

  it("returns ok: true with results for 'search' query", () => {
    // Mock search to return a hit so we can verify the result shape
    vi.mocked(KgQuery).mockImplementationOnce(function () {
      return {
        search: vi.fn().mockReturnValue([{ entity_id: 1, name: "myFunc", kind: "function" }]),
        findDeadCode: vi.fn().mockReturnValue([]),
        getCallers: vi.fn().mockReturnValue([]),
        getCallees: vi.fn().mockReturnValue([]),
        getBlastRadius: vi.fn().mockReturnValue([]),
        getAncestors: vi.fn().mockReturnValue([]),
      };
    } as any);

    const result = graphQuery(
      { query_type: "search", target: "myFunc" },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query_type).toBe("search");
    expect(result.target).toBe("myFunc");
    expect(result.count).toBe(1);
  });

  it("returns ok: true with empty results when entity not found for 'callers'", () => {
    // search returns empty → entity not found → empty callers
    vi.mocked(KgQuery).mockImplementationOnce(function () {
      return {
        search: vi.fn().mockReturnValue([]), // no entity found
        findDeadCode: vi.fn().mockReturnValue([]),
        getCallers: vi.fn().mockReturnValue([]),
        getCallees: vi.fn().mockReturnValue([]),
        getBlastRadius: vi.fn().mockReturnValue([]),
        getAncestors: vi.fn().mockReturnValue([]),
      };
    } as any);

    const result = graphQuery(
      { query_type: "callers", target: "unknownFunc" },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query_type).toBe("callers");
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });
});
