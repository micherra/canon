/**
 * Tests for area observation extraction in write-review.
 *
 * Exercises extractAndStoreAreaObservations behavior via the writeReview public API.
 * The areaMemoryWriter is mocked as a simple object — no SQLite or disk I/O.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AreaMemoryWriter } from "../tools/write-review.ts";
import { type WriteReviewInput, writeReview } from "../tools/write-review.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "write-review-area-memory-test-"));
});

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

function makeInput(overrides: Partial<WriteReviewInput> = {}): WriteReviewInput {
  return {
    files: ["mcp-server/src/features/orchestration/tools/write-review.ts"],
    honored: [],
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    slug: "test-slug",
    verdict: "approved",
    violations: [],
    workspace: tmpDir,
    ...overrides,
  };
}

function makeMockWriter(): {
  writer: AreaMemoryWriter;
  calls: Parameters<AreaMemoryWriter["insertObservation"]>[];
} {
  const calls: Parameters<AreaMemoryWriter["insertObservation"]>[] = [];
  const writer: AreaMemoryWriter = {
    insertObservation: vi.fn((input) => {
      calls.push([input]);
    }),
  };
  return { calls, writer };
}

describe("writeReview — area observation extraction", () => {
  it("creates area observation for BLOCKING review with file_path violations", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          description: "Missing error handling",
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(result.verdict).toBe("BLOCKING");
    expect(calls).toHaveLength(1);
    expect(calls[0][0].subsystem_key).toBe("features/orchestration");
    expect(calls[0][0].source).toBe("reviewer");
    expect(calls[0][0].workflow_slug).toBe("test-slug");
    expect(calls[0][0].content).toContain("errors-are-values");
    expect(calls[0][0].content).toContain("Missing error handling");
  });

  it("creates area observation for WARNING review with file_path violations", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "approved_with_concerns",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "simplicity-first",
          severity: "strong-opinion",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(result.verdict).toBe("WARNING");
    expect(calls).toHaveLength(1);
    expect(calls[0][0].content).toContain("simplicity-first");
    expect(calls[0][0].content).toContain("strong-opinion");
  });

  it("does NOT create observations for CLEAN review", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "approved",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(result.verdict).toBe("CLEAN");
    expect(calls).toHaveLength(0);
  });

  it("skips violations without file_path", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          // No file_path
          principle_id: "errors-are-values",
          severity: "rule",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(calls).toHaveLength(0);
  });

  it("groups multiple violations in same subsystem into one observation", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-plan-index.ts",
          principle_id: "simplicity-first",
          severity: "strong-opinion",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    // Both files resolve to features/orchestration — should be one observation
    expect(calls).toHaveLength(1);
    expect(calls[0][0].subsystem_key).toBe("features/orchestration");
    expect(calls[0][0].content).toContain("2 violations");
  });

  it("creates separate observations for violations in different subsystems", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
        {
          file_path: "mcp-server/src/platform/storage/drift/drift-db.ts",
          principle_id: "simplicity-first",
          severity: "strong-opinion",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => c[0].subsystem_key).sort();
    expect(keys).toEqual(["features/orchestration", "platform/storage/drift"].sort());
  });

  it("is fail-open: areaMemoryWriter.insertObservation throws, review still written", async () => {
    const writer: AreaMemoryWriter = {
      insertObservation: vi.fn(() => {
        throw new Error("DB write failed");
      }),
    };
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
      ],
    });

    // Should not throw — review writing proceeds normally
    const result = await writeReview(input, undefined, undefined, writer);
    assertOk(result);
    expect(result.verdict).toBe("BLOCKING");
  });

  it("no observations when areaMemoryWriter is undefined", async () => {
    // Existing behavior preserved — no writer, no crash
    const input = makeInput({
      verdict: "blocked",
      violations: [
        {
          file_path: "mcp-server/src/features/orchestration/tools/write-review.ts",
          principle_id: "errors-are-values",
          severity: "rule",
        },
      ],
    });

    const result = await writeReview(input, undefined, undefined, undefined);
    assertOk(result);
    expect(result.verdict).toBe("BLOCKING");
  });
});
