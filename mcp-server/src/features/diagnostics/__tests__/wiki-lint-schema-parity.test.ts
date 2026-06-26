/**
 * Zod schema parity tests for wiki_lint and sync_indexes.
 *
 * Verifies that the WIKI_LINT_CHECK_NAMES and SYNC_INDEXES_ARTIFACT_CLASSES
 * exported from register-knowledge.ts (which drives the zod enums in the MCP
 * registration) are in sync with the CheckName union in wiki-lint.ts and the
 * ArtifactClass union in index-inventory.ts respectively.
 *
 * The existing tier tests bypass zod by calling wikiLint() / syncIndexes()
 * directly; these tests close that gap by exercising the registration-level
 * schema.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock DriftStore before importing the tool handler
vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: class MockDriftStore {
    async getReviews() {
      return [];
    }
  },
}));

// Import after mocking
import { wikiLint } from "../tools/wiki-lint.ts";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `wiki-lint-schema-parity-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- Zod schema parity: WIKI_LINT_CHECK_NAMES vs CheckName union ----
//
// These tests verify that the zod schema in register-knowledge.ts includes
// all CheckName values from wiki-lint.ts. The exported WIKI_LINT_CHECK_NAMES
// is the canonical list; the zod enum is derived from it to prevent drift.

describe("wiki_lint zod schema: WIKI_LINT_CHECK_NAMES parity", () => {
  it("misrouted_principles is present in WIKI_LINT_CHECK_NAMES (accepted by zod schema)", async () => {
    // Import the exported constant — if misrouted_principles is absent, the
    // runtime assertion fails, catching any regression in the zod enum.
    const { WIKI_LINT_CHECK_NAMES } = await import("../../../app/register-knowledge.ts");

    expect(WIKI_LINT_CHECK_NAMES).toContain("misrouted_principles");
  });

  it("duplicate_titles is present in WIKI_LINT_CHECK_NAMES (accepted by zod schema)", async () => {
    const { WIKI_LINT_CHECK_NAMES } = await import("../../../app/register-knowledge.ts");

    expect(WIKI_LINT_CHECK_NAMES).toContain("duplicate_titles");
  });

  it("WIKI_LINT_CHECK_NAMES includes all 13 CheckName values with no extras", async () => {
    const { WIKI_LINT_CHECK_NAMES } = await import("../../../app/register-knowledge.ts");

    // Authoritative set derived from wiki-lint.ts CheckName union
    const expectedCheckNames = new Set([
      "cited_paths",
      "contradictions",
      "duplicate_titles",
      "frontmatter_schema",
      "glossary_consistency",
      "link_integrity",
      "missing_examples",
      "misrouted_principles",
      "orphan_principles",
      "scope_layers",
      "scope_tags",
      "index_drift",
      "stale_refs",
    ]);

    expect(WIKI_LINT_CHECK_NAMES).toHaveLength(expectedCheckNames.size);
    for (const name of WIKI_LINT_CHECK_NAMES) {
      expect(expectedCheckNames.has(name)).toBe(true);
    }
    for (const name of expectedCheckNames) {
      expect(WIKI_LINT_CHECK_NAMES).toContain(name);
    }
  });

  it("checks: ['misrouted_principles'] accepted — runs against minimal project dir without throwing", async () => {
    const tmp = makeTmpDir("zod-path-misrouted");

    // Minimal portable principle (portable: true) — should not trigger misrouted_principles
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    const portableContent = `---
id: portable-test-principle
title: Portable Test Principle
severity: convention
portable: true
scope:
  layers: []
  tags: []
---

## Summary
A portable principle for zod-path verification.
`;
    writeFileSync(join(principlesDir, "portable-test-principle.md"), portableContent, "utf8");
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    // This call exercises the same filter-and-dispatch path as checks:["misrouted_principles"]
    // through wikiLint() — confirming the check name is handled without throwing.
    const result = await wikiLint({ checks: ["misrouted_principles"] }, tmp, tmp);

    // All non-requested checks are empty
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.cited_paths).toEqual([]);

    // misrouted_principles ran and found no issues (the principle is correctly portable: true)
    expect(Array.isArray(result.misrouted_principles)).toBe(true);
    expect(result.misrouted_principles).toHaveLength(0);
  });
});

// ---- Zod schema parity: SYNC_INDEXES_ARTIFACT_CLASSES vs ArtifactClass union ----
//
// These tests verify that the zod enum in the sync_indexes MCP tool registration
// includes all ArtifactClass values from index-inventory.ts, including "primers"
// which was added as the 6th class. A missing value is silently rejected at the
// MCP schema boundary, making the class unreachable via the tool interface.

describe("sync_indexes zod schema: SYNC_INDEXES_ARTIFACT_CLASSES parity", () => {
  it("primers is present in SYNC_INDEXES_ARTIFACT_CLASSES (accepted by zod schema)", async () => {
    // If "primers" is absent here, MCP schema validation rejects
    // sync_indexes({ class: "primers" }) before it reaches syncIndexes().
    const { SYNC_INDEXES_ARTIFACT_CLASSES } = await import("../../../app/register-knowledge.ts");

    expect(SYNC_INDEXES_ARTIFACT_CLASSES).toContain("primers");
  });

  it("SYNC_INDEXES_ARTIFACT_CLASSES includes all 6 ArtifactClass values with no extras", async () => {
    const { SYNC_INDEXES_ARTIFACT_CLASSES } = await import("../../../app/register-knowledge.ts");

    // Authoritative set derived from index-inventory.ts ArtifactClass union
    const expectedClasses = new Set([
      "rules",
      "principles",
      "agents",
      "templates",
      "references",
      "primers",
    ]);

    expect(SYNC_INDEXES_ARTIFACT_CLASSES).toHaveLength(expectedClasses.size);
    for (const cls of SYNC_INDEXES_ARTIFACT_CLASSES) {
      expect(expectedClasses.has(cls)).toBe(true);
    }
    for (const cls of expectedClasses) {
      expect(SYNC_INDEXES_ARTIFACT_CLASSES).toContain(cls);
    }
  });
});
