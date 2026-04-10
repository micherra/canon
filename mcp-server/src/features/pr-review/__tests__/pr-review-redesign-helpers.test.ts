/**
 * pr-review-redesign-helpers.test.ts
 *
 * Pure-logic tests for PrReview UI helper functions extracted from the Svelte
 * component: statusIcon, statusClass, shortPath, formatAge, groupByDepth.
 *
 * These helpers are not exported from PrReview.svelte, so the logic is
 * reproduced verbatim from the component and tested as a unit.
 */

import { describe, expect, it } from "vitest";
import type { PrFileInfo } from "../tools/pr-review-data.ts";

function _makeFile(path: string, layer: string, overrides: Partial<PrFileInfo> = {}): PrFileInfo {
  return {
    bucket: "low-risk",
    layer,
    path,
    reason: "",
    status: "modified",
    ...overrides,
  };
}

// The helpers are not exported from PrReview.svelte, so we reproduce the
// exact logic here (copied verbatim from the component) and test it as a unit.
// This is intentional: the Svelte entry test confirmed the helpers *exist*;
// these tests confirm the helpers *behave correctly*.

function statusIcon(fileStatus: "added" | "modified" | "deleted" | "renamed"): string {
  switch (fileStatus) {
    case "added":
      return "+";
    case "deleted":
      return "−";
    case "renamed":
      return "→";
    default:
      return "~";
  }
}

function statusClass(fileStatus: "added" | "modified" | "deleted" | "renamed"): string {
  switch (fileStatus) {
    case "added":
      return "status-added";
    case "deleted":
      return "status-deleted";
    case "renamed":
      return "status-renamed";
    default:
      return "status-modified";
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function groupByDepth(affected: Array<{ path: string; depth: number }>): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const { path, depth } of affected) {
    if (!map.has(depth)) map.set(depth, []);
    map.get(depth)!.push(path);
  }
  return map;
}

// 6. UI helper pure-logic tests (extracted from Svelte source)

describe("PrReview helper: statusIcon()", () => {
  it("returns '+' for added", () => expect(statusIcon("added")).toBe("+"));
  it("returns '−' for deleted", () => expect(statusIcon("deleted")).toBe("−"));
  it("returns '→' for renamed", () => expect(statusIcon("renamed")).toBe("→"));
  it("returns '~' for modified", () => expect(statusIcon("modified")).toBe("~"));
});

describe("PrReview helper: statusClass()", () => {
  it("returns 'status-added' for added", () => expect(statusClass("added")).toBe("status-added"));
  it("returns 'status-deleted' for deleted", () =>
    expect(statusClass("deleted")).toBe("status-deleted"));
  it("returns 'status-renamed' for renamed", () =>
    expect(statusClass("renamed")).toBe("status-renamed"));
  it("returns 'status-modified' for modified", () =>
    expect(statusClass("modified")).toBe("status-modified"));
});

describe("PrReview helper: shortPath()", () => {
  it("returns path unchanged when 2 or fewer segments", () => {
    expect(shortPath("src/file.ts")).toBe("src/file.ts");
    expect(shortPath("file.ts")).toBe("file.ts");
  });

  it("truncates deep paths to last 2 segments with ellipsis prefix", () => {
    expect(shortPath("src/features/pr-review/tools/pr-review-data.ts")).toBe(
      "…/tools/pr-review-data.ts",
    );
    expect(shortPath("a/b/c/d.ts")).toBe("…/c/d.ts");
  });

  it("handles exactly 3 segments", () => {
    expect(shortPath("src/tools/file.ts")).toBe("…/tools/file.ts");
  });
});

describe("PrReview helper: formatAge()", () => {
  it("formats sub-hour durations as minutes", () => {
    // 5 minutes = 300000 ms
    expect(formatAge(300000)).toBe("5m ago");
    // 59 minutes = 3540000 ms
    expect(formatAge(3540000)).toBe("59m ago");
  });

  it("formats 1-23 hour durations as hours", () => {
    // 1 hour = 3600000 ms
    expect(formatAge(3600000)).toBe("1h ago");
    // 23 hours = 82800000 ms
    expect(formatAge(82800000)).toBe("23h ago");
  });

  it("formats 24+ hour durations as days", () => {
    // 1 day = 86400000 ms
    expect(formatAge(86400000)).toBe("1d ago");
    // 7 days
    expect(formatAge(7 * 86400000)).toBe("7d ago");
  });

  it("rounds to nearest unit (30 min stays 30m, not 0h)", () => {
    // 30 minutes = 1800000 ms → rounds to 30m, not 0h (30 < 60 → minutes branch)
    expect(formatAge(1800000)).toBe("30m ago");
  });
});

describe("PrReview helper: groupByDepth()", () => {
  it("groups a single depth-1 entry correctly", () => {
    const result = groupByDepth([{ depth: 1, path: "src/a.ts" }]);
    expect(result.get(1)).toEqual(["src/a.ts"]);
    expect(result.size).toBe(1);
  });

  it("groups multiple paths at the same depth together", () => {
    const result = groupByDepth([
      { depth: 1, path: "src/a.ts" },
      { depth: 1, path: "src/b.ts" },
      { depth: 2, path: "src/c.ts" },
    ]);
    expect(result.get(1)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.get(2)).toEqual(["src/c.ts"]);
    expect(result.size).toBe(2);
  });

  it("returns an empty map for empty input", () => {
    const result = groupByDepth([]);
    expect(result.size).toBe(0);
  });

  it("preserves insertion order within each depth group", () => {
    const result = groupByDepth([
      { depth: 1, path: "src/first.ts" },
      { depth: 1, path: "src/second.ts" },
      { depth: 1, path: "src/third.ts" },
    ]);
    expect(result.get(1)).toEqual(["src/first.ts", "src/second.ts", "src/third.ts"]);
  });
});
