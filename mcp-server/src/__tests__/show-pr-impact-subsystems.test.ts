/**
 * Unit tests for detectSubsystems and buildBlastRadiusByFile helpers
 * in show-pr-impact.ts.
 *
 * Tests:
 *   detectSubsystems:
 *     1. Returns "new" for directory with 3+ added files
 *     2. Returns "removed" for directory with 3+ deleted files
 *     3. Returns empty for directories with fewer than 3 files of same status
 *     4. Handles mixed add/delete in same directory (both labels emitted)
 *     5. Handles single-segment paths
 *     6. Handles empty file list
 *     7. Groups by first two directory segments
 *     8. Sorts by file_count descending
 *
 *   buildBlastRadiusByFile:
 *     1. Groups affected entries by file_path and counts
 *     2. Returns empty array for undefined input
 *     3. Sorts descending by dep_count
 *     4. Limits to top 15 entries
 */

import { describe, it, expect } from "vitest";
import { detectSubsystems, buildBlastRadiusByFile } from "../tools/show-pr-impact.ts";
import type { Subsystem, BlastRadiusFileEntry } from "../tools/show-pr-impact.ts";

// ---------------------------------------------------------------------------
// detectSubsystems
// ---------------------------------------------------------------------------

describe("detectSubsystems — new subsystem detection", () => {
  it("returns 'new' for a directory with 3+ added files", () => {
    const files = [
      "src/tools/alpha.ts",
      "src/tools/beta.ts",
      "src/tools/gamma.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/tools/alpha.ts", "added"],
      ["src/tools/beta.ts", "added"],
      ["src/tools/gamma.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject<Subsystem>({
      directory: "src/tools",
      label: "new",
      file_count: 3,
    });
  });

  it("returns 'removed' for a directory with 3+ deleted files", () => {
    const files = [
      "src/old/a.ts",
      "src/old/b.ts",
      "src/old/c.ts",
      "src/old/d.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/old/a.ts", "deleted"],
      ["src/old/b.ts", "deleted"],
      ["src/old/c.ts", "deleted"],
      ["src/old/d.ts", "deleted"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject<Subsystem>({
      directory: "src/old",
      label: "removed",
      file_count: 4,
    });
  });

  it("returns empty for directories with fewer than 3 files of same status", () => {
    const files = [
      "src/tools/alpha.ts",
      "src/tools/beta.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/tools/alpha.ts", "added"],
      ["src/tools/beta.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(0);
  });

  it("handles mixed add/delete in same directory — emits both labels", () => {
    const files = [
      "src/mixed/a.ts",
      "src/mixed/b.ts",
      "src/mixed/c.ts",
      "src/mixed/x.ts",
      "src/mixed/y.ts",
      "src/mixed/z.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/mixed/a.ts", "added"],
      ["src/mixed/b.ts", "added"],
      ["src/mixed/c.ts", "added"],
      ["src/mixed/x.ts", "deleted"],
      ["src/mixed/y.ts", "deleted"],
      ["src/mixed/z.ts", "deleted"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(2);
    const labels = result.map((r) => r.label);
    expect(labels).toContain("new");
    expect(labels).toContain("removed");
  });

  it("handles single-segment paths (root-level files)", () => {
    const files = ["alpha.ts", "beta.ts", "gamma.ts"];
    const statusMap = new Map<string, string>([
      ["alpha.ts", "added"],
      ["beta.ts", "added"],
      ["gamma.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("new");
    expect(result[0].file_count).toBe(3);
  });

  it("returns empty array for empty file list", () => {
    const result = detectSubsystems([], new Map());
    expect(result).toEqual([]);
  });

  it("groups by first two directory segments", () => {
    // src/tools/nested/deep.ts and src/tools/other.ts should both go to src/tools
    const files = [
      "src/tools/nested/deep.ts",
      "src/tools/other.ts",
      "src/tools/third.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/tools/nested/deep.ts", "added"],
      ["src/tools/other.ts", "added"],
      ["src/tools/third.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(1);
    expect(result[0].directory).toBe("src/tools");
    expect(result[0].file_count).toBe(3);
  });

  it("sorts results descending by file_count", () => {
    const files = [
      // src/small — 3 added
      "src/small/a.ts",
      "src/small/b.ts",
      "src/small/c.ts",
      // src/large — 5 added
      "src/large/a.ts",
      "src/large/b.ts",
      "src/large/c.ts",
      "src/large/d.ts",
      "src/large/e.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/small/a.ts", "added"],
      ["src/small/b.ts", "added"],
      ["src/small/c.ts", "added"],
      ["src/large/a.ts", "added"],
      ["src/large/b.ts", "added"],
      ["src/large/c.ts", "added"],
      ["src/large/d.ts", "added"],
      ["src/large/e.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    expect(result).toHaveLength(2);
    expect(result[0].file_count).toBeGreaterThan(result[1].file_count);
    expect(result[0].directory).toBe("src/large");
  });
});

// ---------------------------------------------------------------------------
// buildBlastRadiusByFile
// ---------------------------------------------------------------------------

describe("buildBlastRadiusByFile — grouping and counting", () => {
  it("groups affected entries by file_path and counts", () => {
    const blastRadius = {
      total_affected: 3,
      affected_files: 2,
      by_depth: { 1: 3 },
      affected: [
        { entity_name: "foo", entity_kind: "function", file_path: "src/a.ts", depth: 1 },
        { entity_name: "bar", entity_kind: "class", file_path: "src/a.ts", depth: 1 },
        { entity_name: "baz", entity_kind: "function", file_path: "src/b.ts", depth: 1 },
      ],
    };
    const result = buildBlastRadiusByFile(blastRadius);
    expect(result).toHaveLength(2);
    const aEntry = result.find((e) => e.file === "src/a.ts");
    const bEntry = result.find((e) => e.file === "src/b.ts");
    expect(aEntry?.dep_count).toBe(2);
    expect(bEntry?.dep_count).toBe(1);
  });

  it("returns empty array for undefined input", () => {
    const result = buildBlastRadiusByFile(undefined);
    expect(result).toEqual([]);
  });

  it("sorts descending by dep_count", () => {
    const blastRadius = {
      total_affected: 5,
      affected_files: 3,
      by_depth: { 1: 5 },
      affected: [
        { entity_name: "e1", entity_kind: "function", file_path: "src/low.ts", depth: 1 },
        { entity_name: "e2", entity_kind: "function", file_path: "src/high.ts", depth: 1 },
        { entity_name: "e3", entity_kind: "function", file_path: "src/high.ts", depth: 1 },
        { entity_name: "e4", entity_kind: "function", file_path: "src/high.ts", depth: 1 },
        { entity_name: "e5", entity_kind: "function", file_path: "src/mid.ts", depth: 1 },
        { entity_name: "e6", entity_kind: "function", file_path: "src/mid.ts", depth: 1 },
      ],
    };
    const result = buildBlastRadiusByFile(blastRadius);
    expect(result[0].file).toBe("src/high.ts");
    expect(result[0].dep_count).toBe(3);
    expect(result[1].dep_count).toBe(2);
    expect(result[2].dep_count).toBe(1);
  });

  it("limits to top 15 entries", () => {
    // Create 20 distinct files with 1 entry each
    const affected = Array.from({ length: 20 }, (_, i) => ({
      entity_name: `e${i}`,
      entity_kind: "function",
      file_path: `src/file${i}.ts`,
      depth: 1,
    }));
    const blastRadius = {
      total_affected: 20,
      affected_files: 20,
      by_depth: { 1: 20 },
      affected,
    };
    const result = buildBlastRadiusByFile(blastRadius);
    expect(result).toHaveLength(15);
  });

  it("returns correct BlastRadiusFileEntry shape", () => {
    const blastRadius = {
      total_affected: 1,
      affected_files: 1,
      by_depth: { 1: 1 },
      affected: [
        { entity_name: "fn", entity_kind: "function", file_path: "src/x.ts", depth: 1 },
      ],
    };
    const result = buildBlastRadiusByFile(blastRadius);
    expect(result).toHaveLength(1);
    const entry: BlastRadiusFileEntry = result[0];
    expect(entry).toHaveProperty("file");
    expect(entry).toHaveProperty("dep_count");
  });
});
