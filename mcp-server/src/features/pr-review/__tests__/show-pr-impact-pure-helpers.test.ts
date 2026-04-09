/**
 * Pure function tests for detectSubsystems and buildBlastRadiusByFile helpers.
 *
 * Split from show-pr-impact-new-fields.test.ts (was 688 lines):
 *   - Suite 4: detectSubsystems declared known gaps
 *   - Suite 5: buildBlastRadiusByFile declared known gaps
 *
 * These are pure function tests — no async, no mocks, no tmpDir required.
 */

import { describe, expect, it } from "vitest";
import { buildBlastRadiusByFile, detectSubsystems } from "../tools/show-pr-impact.ts";

// Suite 4: detectSubsystems declared known gaps (pure function tests)

describe("detectSubsystems — declared known gaps", () => {
  it("does not count 'modified' files toward subsystem threshold", () => {
    // Per design: only 'added' and 'deleted' trigger subsystem labels
    const files = ["src/widgets/alpha.ts", "src/widgets/beta.ts", "src/widgets/gamma.ts"];
    const statusMap = new Map<string, string>([
      ["src/widgets/alpha.ts", "modified"],
      ["src/widgets/beta.ts", "modified"],
      ["src/widgets/gamma.ts", "modified"],
    ]);

    const result = detectSubsystems(files, statusMap);

    // 'modified' files do NOT count — result should be empty even with 3 files
    expect(result).toEqual([]);
  });

  it("does not count 'renamed' files toward subsystem threshold", () => {
    const files = ["src/widgets/alpha.ts", "src/widgets/beta.ts", "src/widgets/gamma.ts"];
    const statusMap = new Map<string, string>([
      ["src/widgets/alpha.ts", "renamed"],
      ["src/widgets/beta.ts", "renamed"],
      ["src/widgets/gamma.ts", "renamed"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toEqual([]);
  });

  it("only 'added' files contribute to 'new' subsystem label", () => {
    // Mix of added + modified in same dir — only added files count
    const files = [
      "src/mixed/a.ts",
      "src/mixed/b.ts",
      "src/mixed/c.ts", // modified — should not count
      "src/mixed/d.ts", // modified — should not count
    ];
    const statusMap = new Map<string, string>([
      ["src/mixed/a.ts", "added"],
      ["src/mixed/b.ts", "added"],
      ["src/mixed/c.ts", "modified"],
      ["src/mixed/d.ts", "modified"],
    ]);

    const result = detectSubsystems(files, statusMap);

    // Only 2 "added" files — threshold not met — no subsystem
    expect(result).toEqual([]);
  });

  it("threshold is inclusive at exactly 3 — exactly 3 added files triggers subsystem", () => {
    const files = ["src/exact/a.ts", "src/exact/b.ts", "src/exact/c.ts"];
    const statusMap = new Map<string, string>([
      ["src/exact/a.ts", "added"],
      ["src/exact/b.ts", "added"],
      ["src/exact/c.ts", "added"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toHaveLength(1);
    expect(result[0].file_count).toBe(3);
  });

  it("threshold boundary: exactly 2 files does NOT trigger subsystem", () => {
    const files = ["src/exact/a.ts", "src/exact/b.ts"];
    const statusMap = new Map<string, string>([
      ["src/exact/a.ts", "added"],
      ["src/exact/b.ts", "added"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toHaveLength(0);
  });

  it("file with no status in statusMap is not counted", () => {
    // File in list but no entry in statusMap — treated as having no counted status
    const files = ["src/ghost/a.ts", "src/ghost/b.ts", "src/ghost/c.ts"];
    // statusMap is empty — none have a status
    const result = detectSubsystems(files, new Map());

    expect(result).toEqual([]);
  });
});

// Suite 5: buildBlastRadiusByFile declared known gaps

describe("buildBlastRadiusByFile — declared known gaps", () => {
  it("skips entries with empty string file_path", () => {
    const blastRadius = {
      affected: [
        { depth: 1, entity_kind: "function", entity_name: "fn1", file_path: "" },
        { depth: 1, entity_kind: "function", entity_name: "fn2", file_path: "" },
        { depth: 1, entity_kind: "function", entity_name: "fn3", file_path: "src/real.ts" },
      ],
      affected_files: 1,
      by_depth: { 1: 3 },
      total_affected: 3,
    };

    const result = buildBlastRadiusByFile(blastRadius);

    // Only the entry with a real file_path should be counted
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/real.ts");
    expect(result[0].dep_count).toBe(1);
  });

  it("skips entries with null-ish file_path (falsy guard covers undefined)", () => {
    const blastRadius = {
      affected: [
        // TypeScript type says file_path is string, but at runtime guard handles falsy
        {
          depth: 1,
          entity_kind: "function",
          entity_name: "fn1",
          file_path: null as unknown as string,
        },
        { depth: 1, entity_kind: "function", entity_name: "fn2", file_path: "src/valid.ts" },
      ],
      affected_files: 1,
      by_depth: { 1: 2 },
      total_affected: 2,
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/valid.ts");
  });

  it("returns empty array when all entries have empty file_path", () => {
    const blastRadius = {
      affected: [
        { depth: 1, entity_kind: "function", entity_name: "fn1", file_path: "" },
        { depth: 1, entity_kind: "function", entity_name: "fn2", file_path: "" },
      ],
      affected_files: 0,
      by_depth: { 1: 2 },
      total_affected: 2,
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toEqual([]);
  });

  it("returns empty array for blastRadius with empty affected array", () => {
    const blastRadius = {
      affected: [],
      affected_files: 0,
      by_depth: {},
      total_affected: 0,
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toEqual([]);
  });
});
