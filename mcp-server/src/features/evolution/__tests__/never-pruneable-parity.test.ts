/**
 * never-pruneable-parity.test.ts — prose↔code parity test (ADR-0062 Bug-1).
 *
 * NEVER_PRUNEABLE_PRINCIPLE_IDS (mutation-selection.ts) is the code source of
 * truth for the allowlist guard. The same 7-id list is documented in prose at
 * TWO call sites in `skills/canon/commands/review-learnings.md` (the
 * retire-refusal check ~line 96, and the Safety rails bullet ~line 363) — both
 * must stay in byte-parity with the const, or the guard silently drifts from
 * what the writer's own refusal instructions describe.
 *
 * Mirrors the precedent structure of
 * `features/orchestration/__tests__/deny-list-parity.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEVER_PRUNEABLE_PRINCIPLE_IDS } from "../services/mutation-selection.ts";

// mcp-server/src/features/evolution/__tests__/ -> repo root is 5 levels up.
const REVIEW_LEARNINGS_PATH = join(
  import.meta.dirname,
  "../../../../../skills/canon/commands/review-learnings.md",
);

/** Extract backtick-wrapped ids from the first (and only) parenthesized group on a line. */
function extractAllowlistIdsFromLine(line: string): string[] {
  const parenMatch = line.match(/\(([^)]*)\)/);
  if (!parenMatch) return [];
  const matches = parenMatch[1].match(/`([a-z0-9_-]+)`/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

/** Union the allowlist ids across every "never-pruneable"-mentioning line in the file. */
function extractDocumentedAllowlistIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.toLowerCase().includes("never-pruneable")) continue;
    for (const id of extractAllowlistIdsFromLine(line)) ids.add(id);
  }
  return ids;
}

describe("never-pruneable-parity", () => {
  it("review-learnings.md documents the never-pruneable allowlist", () => {
    const content = readFileSync(REVIEW_LEARNINGS_PATH, "utf8");
    expect(content).toContain("never-pruneable");
  });

  it("documented allowlist ids == NEVER_PRUNEABLE_PRINCIPLE_IDS (both call sites)", () => {
    const content = readFileSync(REVIEW_LEARNINGS_PATH, "utf8");
    const documented = extractDocumentedAllowlistIds(content);
    const code = new Set(NEVER_PRUNEABLE_PRINCIPLE_IDS);

    expect(documented.size).toBeGreaterThan(0);

    const addedInCode = [...code].filter((id) => !documented.has(id));
    const removedFromCode = [...documented].filter((id) => !code.has(id));

    expect(
      addedInCode,
      `Id added to NEVER_PRUNEABLE_PRINCIPLE_IDS but missing from review-learnings.md: ${addedInCode.join(", ")}`,
    ).toEqual([]);
    expect(
      removedFromCode,
      `review-learnings.md documents an id no longer in NEVER_PRUNEABLE_PRINCIPLE_IDS: ${removedFromCode.join(", ")}`,
    ).toEqual([]);
  });

  it("both call sites (~line 96, ~line 363) individually carry the full 7-id list", () => {
    const content = readFileSync(REVIEW_LEARNINGS_PATH, "utf8");
    const lines = content.split("\n");
    const listLines = lines.filter(
      (line) =>
        line.toLowerCase().includes("never-pruneable") &&
        extractAllowlistIdsFromLine(line).length > 0,
    );

    expect(listLines.length).toBe(2);
    for (const line of listLines) {
      expect(new Set(extractAllowlistIdsFromLine(line))).toEqual(
        new Set(NEVER_PRUNEABLE_PRINCIPLE_IDS),
      );
    }
  });
});
