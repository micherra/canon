/**
 * Unit tests for context-budget.ts
 *
 * Tests getItemCountCap tier-to-cap mapping and default fallback.
 */

import { describe, expect, it } from "vitest";
import { getItemCountCap } from "../orchestration/context-budget.ts";

describe("getItemCountCap", () => {
  it("returns 5 for small tier", () => {
    expect(getItemCountCap("small")).toBe(5);
  });

  it("returns 15 for medium tier", () => {
    expect(getItemCountCap("medium")).toBe(15);
  });

  it("returns 30 for large tier", () => {
    expect(getItemCountCap("large")).toBe(30);
  });

  it("returns 15 (default) for an unknown/unexpected tier value", () => {
    // Type assertion to simulate runtime call with unexpected value
    expect(getItemCountCap("unknown" as "small" | "medium" | "large")).toBe(15);
  });
});
