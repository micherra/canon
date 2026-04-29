import { describe, expect, it } from "vitest";
import { getItemCountCap } from "../context-budget.ts";

describe("getItemCountCap", () => {
  it('returns 5 for "small" tier', () => {
    expect(getItemCountCap("small")).toBe(5);
  });

  it('returns 15 for "medium" tier', () => {
    expect(getItemCountCap("medium")).toBe(15);
  });

  it('returns 30 for "large" tier', () => {
    expect(getItemCountCap("large")).toBe(30);
  });

  it("returns 15 for undefined tier", () => {
    expect(getItemCountCap(undefined)).toBe(15);
  });
});
