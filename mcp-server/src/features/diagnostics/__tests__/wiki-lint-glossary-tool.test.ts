/**
 * Integration tests for the glossary_consistency check in the wiki_lint tool handler.
 *
 * Test plan:
 * - selective checks: glossary_consistency-only runs only that check and detects exact-duplicate
 * - AC-4: real CONTEXT.md returns [] for glossary_consistency (current glossary is CLEAN)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// mcp-server/src/features/diagnostics/__tests__ → 5 levels up = repo root
const REPO_ROOT = resolve(__dirname, "../../../../..");

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

// ---- Helpers ----

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `wiki-lint-glossary-tool-test-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePrincipleWithExamples(dir: string, id: string): void {
  const content = `---
id: ${id}
title: ${id} title
severity: strong-opinion
scope:
  layers: []
  tags: []
---

## Summary
A test principle with examples.

## Examples

\`\`\`typescript
// good example
const x = 1;
\`\`\`
`;
  writeFileSync(join(dir, `${id}.md`), content, "utf8");
}

// ---- Tests ----

describe("wikiLint glossary_consistency check (tool wiring)", () => {
  it("selective checks: glossary_consistency-only runs only that check and detects exact-duplicate", async () => {
    const tmp = makeTmpDir("glossary-selective");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // Seeded CONTEXT.md with an exact-duplicate heading
    writeFileSync(
      join(tmp, "CONTEXT.md"),
      [
        "# Context",
        "",
        "## Wave",
        "First definition of wave.",
        "",
        "## Wave",
        "Second definition of wave.",
      ].join("\n"),
      "utf8",
    );

    const result = await wikiLint({ checks: ["glossary_consistency"] }, tmp, tmp);

    // Non-requested checks must be empty
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.cited_paths).toEqual([]);
    expect(result.scope_layers).toEqual([]);
    expect(result.scope_tags).toEqual([]);

    // glossary_consistency detected the duplicate
    expect(result.glossary_consistency).toHaveLength(1);
    expect(result.glossary_consistency[0].term).toBe("wave");
    expect(result.glossary_consistency[0].kind).toBe("exact-duplicate");

    // total_findings includes the glossary finding
    expect(result.summary.total_findings).toBe(1);
  });

  it("AC-4: real CONTEXT.md returns [] for glossary_consistency — current glossary is CLEAN", async () => {
    // This test runs against the actual CONTEXT.md in the repository.
    // The decision glossary-consistency-01 established that two fully-qualified
    // Tier entries (no naked ## Tier) are ALLOWED, not flagged.
    // If this test fails, CONTEXT.md has been edited to introduce a collision.
    const result = await wikiLint({ checks: ["glossary_consistency"] }, REPO_ROOT, REPO_ROOT);
    expect(result.glossary_consistency).toEqual([]);
  });
});
