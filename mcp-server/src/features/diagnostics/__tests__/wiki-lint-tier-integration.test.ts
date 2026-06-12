/**
 * Integration verification: tier checks run against actual repo tree → zero findings.
 * Verifies the relocation peer task cleaned the tree.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllPrinciples } from "@shared/matcher.ts";
import {
  checkDuplicateTitles,
  checkMisroutedPrinciples,
} from "../services/wiki-lint-principle-tier.ts";

// 5 levels up from __tests__ lands at the worktree root (contains principles/, .canon/, etc.)
// Path: mcp-server/src/features/diagnostics/__tests__ → ../../../../../ = worktree/
const worktreeDir = join(import.meta.dirname, "../../../../../");

describe("integration: tier checks on actual repo tree", () => {
  it("misrouted_principles: 0 findings on cleaned repo tree", async () => {
    const principles = await loadAllPrinciples(worktreeDir, worktreeDir);
    expect(principles.length).toBeGreaterThan(0);
    const findings = checkMisroutedPrinciples(principles);
    expect(findings).toHaveLength(0);
  });

  it("duplicate_titles: 0 findings on cleaned repo tree", async () => {
    const principles = await loadAllPrinciples(worktreeDir, worktreeDir);
    const findings = checkDuplicateTitles(principles);
    expect(findings).toHaveLength(0);
  });
});
