/**
 * deny-list-parity — prose↔code parity test (ADR-0042 corpus-drift posture).
 *
 * The sensitive-path deny-list floor's authoritative category set lives in
 * exactly one place: SENSITIVE_PATH_DENY_LIST (confidence-scorer.ts). Root
 * CLAUDE.md documents the same category set by NAME only (never duplicating
 * glob patterns, which would themselves drift) in a single `Categories: ...`
 * line under the "Sensitive-path deny-list floor" subsection.
 *
 * This test extracts the backtick-wrapped category tokens from that line and
 * asserts the set is exactly equal to the const's category set — catching any
 * future edit that adds/removes a category in code without updating the prose
 * (or vice versa).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SENSITIVE_PATH_DENY_LIST } from "../services/confidence-scorer.ts";

// mcp-server/src/features/orchestration/__tests__/ -> repo root is 5 levels up.
const CLAUDE_MD_PATH = join(import.meta.dirname, "../../../../../CLAUDE.md");

/** Extract the backtick-wrapped tokens on the "Categories: ..." line. */
function extractDocumentedCategories(claudeMd: string): string[] {
  const line = claudeMd.split("\n").find((l) => l.trim().startsWith("Categories:"));
  if (!line) return [];
  const matches = line.match(/`([a-z-]+)`/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

describe("deny-list-parity", () => {
  it("root CLAUDE.md documents the sensitive-path deny-list floor", () => {
    const claudeMd = readFileSync(CLAUDE_MD_PATH, "utf8");
    expect(claudeMd).toContain("deny-list floor");
    expect(claudeMd).toContain("SENSITIVE_PATH_DENY_LIST");
  });

  it("documented category set == SENSITIVE_PATH_DENY_LIST category set", () => {
    const claudeMd = readFileSync(CLAUDE_MD_PATH, "utf8");
    const documented = new Set<string>(extractDocumentedCategories(claudeMd));
    const codeCategories = new Set<string>(SENSITIVE_PATH_DENY_LIST.map((e) => e.category));

    expect(documented.size).toBeGreaterThan(0);

    const addedInCode = [...codeCategories].filter((c) => !documented.has(c));
    const removedFromCode = [...documented].filter((c) => !codeCategories.has(c));

    expect(
      addedInCode,
      `Category added to SENSITIVE_PATH_DENY_LIST but missing from CLAUDE.md: ${addedInCode.join(", ")}`,
    ).toEqual([]);
    expect(
      removedFromCode,
      `CLAUDE.md documents a category no longer in SENSITIVE_PATH_DENY_LIST: ${removedFromCode.join(", ")}`,
    ).toEqual([]);
  });
});
