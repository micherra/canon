/**
 * Integration tests for the wiki_lint MCP tool handler.
 *
 * Tests the wikiLint() function directly — imports the handler, mocks DriftStore,
 * and verifies that each lint check is wired correctly via a temp-dir filesystem.
 *
 * Test plan:
 * - happy path: all checks run, all seeded findings detected
 * - selective checks: only orphan_principles runs, others empty
 * - clean codebase: no findings, total_findings = 0
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock DriftStore before importing the tool handler
// Default mock: returns empty reviews (no violations recorded)
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
  const dir = join(tmpdir(), `wiki-lint-tool-test-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a minimal principle file with an Examples section.
 */
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

/**
 * Write a minimal principle file WITHOUT an Examples section.
 */
function writePrincipleWithoutExamples(dir: string, id: string): void {
  const content = `---
id: ${id}
title: ${id} title
severity: convention
scope:
  layers: []
  tags: []
---

## Summary
A test principle without examples.
`;
  writeFileSync(join(dir, `${id}.md`), content, "utf8");
}

// ---- Tests ----

describe("wikiLint tool handler", () => {
  it("happy path: all checks run and seed findings are detected", async () => {
    const tmp = makeTmpDir("happy");

    // Principles dir — one with examples, one without
    const principlesDir = join(tmp, "principles", "strong-opinions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "has-examples");
    writePrincipleWithoutExamples(principlesDir, "no-examples");

    // Two CLAUDE.md files with a cross-file contradiction and a stale ref
    const dirA = join(tmp, "module-a");
    const dirB = join(tmp, "module-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    writeFileSync(
      join(dirA, "CLAUDE.md"),
      "# Module A\nYou must use isolation for agents.\nSee `docs/nonexistent-file.md` for details.\n",
      "utf8",
    );
    writeFileSync(join(dirB, "CLAUDE.md"), "# Module B\nNever use isolation for agents.\n", "utf8");

    // Agents dir referencing one principle
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "test-agent.md"),
      "---\nname: test\n---\n\nThis agent applies has-examples principle.\n",
      "utf8",
    );

    const result = await wikiLint({}, tmp, tmp);

    // Contradiction: "isolation" entity has cross-file must/never conflict
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.contradictions[0].entity).toContain("isolation");

    // Missing examples: no-examples principle
    expect(result.missing_examples.length).toBeGreaterThan(0);
    expect(result.missing_examples.some((f) => f.principle_id === "no-examples")).toBe(true);

    // Stale ref: nonexistent-file.md
    expect(result.stale_refs.length).toBeGreaterThan(0);
    expect(result.stale_refs.some((f) => f.referenced_path.includes("nonexistent-file.md"))).toBe(
      true,
    );

    // Summary
    expect(result.summary.total_findings).toBeGreaterThan(0);
    expect(result.summary.files_scanned).toBeGreaterThan(0);
  });

  it("selective checks: only orphan_principles runs, others return empty arrays", async () => {
    const tmp = makeTmpDir("selective");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithoutExamples(principlesDir, "orphan-principle");

    // One CLAUDE.md — no references to the principle, no contradictions
    mkdirSync(join(tmp, "root"), { recursive: true });
    writeFileSync(join(tmp, "root", "CLAUDE.md"), "# Root\nSome instructions.\n", "utf8");

    const result = await wikiLint({ checks: ["orphan_principles"] }, tmp, tmp);

    // Non-requested checks must be empty
    expect(result.contradictions).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);

    // Orphan check ran — principle not referenced or violated
    expect(result.orphan_principles.some((f) => f.principle_id === "orphan-principle")).toBe(true);
  });

  it("orphan check: principle is NOT flagged as orphan when it appears in DriftStore violations", async () => {
    const tmp = makeTmpDir("driftstore-violated");

    // One principle — not referenced in any text file
    const principlesDir = join(tmp, "principles", "strong-opinions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "violated-principle");

    // CLAUDE.md that does NOT reference the principle text
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nSome unrelated instructions.\n", "utf8");

    // Override DriftStore mock to return a review with the principle as a violation
    const { DriftStore } = await import("@platform/storage/drift/store.ts");
    (DriftStore as { prototype: { getReviews: () => Promise<unknown[]> } }).prototype.getReviews =
      async () => [
        {
          id: "rev-1",
          violations: [{ principle_id: "violated-principle", file_path: "some/file.ts" }],
        },
      ];

    const result = await wikiLint({ checks: ["orphan_principles"] }, tmp, tmp);

    // The violated principle should NOT appear in orphan_principles
    expect(result.orphan_principles.some((f) => f.principle_id === "violated-principle")).toBe(
      false,
    );
  });

  it("clean codebase: no findings when everything is valid", async () => {
    const tmp = makeTmpDir("clean");

    // One principle with examples
    const principlesDir = join(tmp, "principles", "rules");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "clean-principle");

    // One CLAUDE.md with no contradictions and no stale refs
    writeFileSync(join(tmp, "CLAUDE.md"), "# Clean\nUse clean-principle as your guide.\n", "utf8");

    // Agents dir referencing the principle so it isn't orphaned
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "test-agent.md"),
      "---\nname: test\n---\n\nApplies clean-principle.\n",
      "utf8",
    );

    const result = await wikiLint({}, tmp, tmp);

    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.summary.total_findings).toBe(0);
  });
});
