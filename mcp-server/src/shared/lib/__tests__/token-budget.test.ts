/**
 * token-budget.test.ts — Tests for estimateTokens and fitWithinBudget
 *
 * Tests cover:
 * 1. estimateTokens returns 0 for empty string
 * 2. estimateTokens returns 0 for whitespace-only string
 * 3. estimateTokens returns correct estimate for known text ("hello world" -> ceil(2 * 1.3) = 3)
 * 4. estimateTokens handles multiline text correctly
 * 5. fitWithinBudget returns empty array for budget <= 0
 * 6. fitWithinBudget returns empty array for empty items
 * 7. fitWithinBudget selects highest-priority items first
 * 8. fitWithinBudget stops when budget is exhausted
 * 9. fitWithinBudget skips items that individually exceed remaining budget
 * 10. fitWithinBudget preserves generic type fields on returned items
 */

import { describe, expect, it } from "vitest";
import { estimateTokens, fitWithinBudget } from "../token-budget.ts";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(estimateTokens("   ")).toBe(0);
    expect(estimateTokens("\t\n  \r")).toBe(0);
  });

  it("returns correct estimate for known text", () => {
    // "hello world" = 2 words, ceil(2 * 1.3) = ceil(2.6) = 3
    expect(estimateTokens("hello world")).toBe(3);
  });

  it("returns correct estimate for single word", () => {
    // 1 word, ceil(1 * 1.3) = ceil(1.3) = 2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("handles multiline text correctly", () => {
    // "line one\nline two\nline three" = 6 words, ceil(6 * 1.3) = ceil(7.8) = 8
    const text = "line one\nline two\nline three";
    expect(estimateTokens(text)).toBe(8);
  });

  it("handles tabs and mixed whitespace as word separators", () => {
    // "word1\tword2" = 2 words, ceil(2 * 1.3) = 3
    expect(estimateTokens("word1\tword2")).toBe(3);
  });

  it("handles a single very long word with no spaces", () => {
    // 1 word, ceil(1 * 1.3) = 2
    expect(estimateTokens("supercalifragilisticexpialidocious")).toBe(2);
  });
});

describe("fitWithinBudget", () => {
  it("returns empty array for budget <= 0", () => {
    const items = [{ priority: 1, text: "hello world" }];
    expect(fitWithinBudget(items, 0)).toEqual([]);
    expect(fitWithinBudget(items, -5)).toEqual([]);
  });

  it("returns empty array for empty items", () => {
    expect(fitWithinBudget([], 100)).toEqual([]);
  });

  it("selects highest-priority items first", () => {
    const items = [
      { priority: 1, text: "low priority item" },
      { priority: 10, text: "high priority item" },
      { priority: 5, text: "medium priority item" },
    ];
    // Each item has 3 words: ceil(3 * 1.3) = ceil(3.9) = 4 tokens
    // Budget of 5 should fit only the first selected item (high priority)
    const result = fitWithinBudget(items, 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.priority).toBe(10);
  });

  it("selects multiple items in priority order when budget allows", () => {
    const items = [
      { priority: 1, text: "a" },
      { priority: 3, text: "b" },
      { priority: 2, text: "c" },
    ];
    // Each item is 1 word: ceil(1 * 1.3) = 2 tokens
    // Budget of 6 allows all three (2 + 2 + 2 = 6)
    const result = fitWithinBudget(items, 6);
    expect(result).toHaveLength(3);
    // Result should be in priority order: b (3), c (2), a (1)
    expect(result[0]?.text).toBe("b");
    expect(result[1]?.text).toBe("c");
    expect(result[2]?.text).toBe("a");
  });

  it("stops when budget is exhausted", () => {
    const items = [
      { priority: 10, text: "first high priority item text here" },
      { priority: 5, text: "second medium item here" },
      { priority: 1, text: "z" },
    ];
    // "first high priority item text here" = 6 words -> ceil(6 * 1.3) = 8 tokens
    // Budget of 8 fits only the first item
    const result = fitWithinBudget(items, 8);
    expect(result).toHaveLength(1);
    expect(result[0]?.priority).toBe(10);
  });

  it("skips items that individually exceed remaining budget", () => {
    // After the highest priority item is selected, remaining budget is too small
    // for the second item but enough for the third (smaller) item.
    const items = [
      { priority: 10, text: "alpha beta gamma delta" }, // 4 words -> ceil(4*1.3) = ceil(5.2) = 6
      { priority: 5, text: "large item that will not fit because it is too long" }, // 11 words -> ceil(11*1.3) = ceil(14.3) = 15
      { priority: 1, text: "small" }, // 1 word -> ceil(1*1.3) = 2
    ];
    // Budget of 8: take priority-10 (6 tokens, 2 remaining), skip priority-5 (15 > 2), take priority-1 (2 tokens)
    const result = fitWithinBudget(items, 8);
    expect(result).toHaveLength(2);
    expect(result[0]?.priority).toBe(10);
    expect(result[1]?.priority).toBe(1);
  });

  it("preserves generic type fields on returned items", () => {
    type RichItem = {
      label: string;
      priority: number;
      score: number;
      text: string;
    };
    const items: RichItem[] = [
      { label: "greeting", priority: 5, score: 42, text: "hello world" },
      { label: "farewell", priority: 1, score: 7, text: "bye" },
    ];
    const result = fitWithinBudget(items, 100);
    expect(result).toHaveLength(2);
    // All original fields preserved
    expect(result[0]).toEqual({ label: "greeting", priority: 5, score: 42, text: "hello world" });
    expect(result[1]).toEqual({ label: "farewell", priority: 1, score: 7, text: "bye" });
  });

  it("handles items with equal priority (stable relative order)", () => {
    // Items with equal priority — budget allows only one
    // The JS sort is stable, so whichever comes first in input is selected
    const items = [
      { priority: 5, text: "item one text words here" },
      { priority: 5, text: "item two text words here" },
    ];
    // Each: 5 words -> ceil(5 * 1.3) = ceil(6.5) = 7 tokens
    // Budget of 7 fits only 1
    const result = fitWithinBudget(items, 7);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("item one text words here");
  });
});
