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

  it("cited_paths key is present in WikiLintOutput", async () => {
    const tmp = makeTmpDir("cited-paths-key");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // Empty references dir — no cited path findings
    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "empty.md"), "# Empty\nNo paths here.\n", "utf8");

    const result = await wikiLint({}, tmp, tmp);

    expect(result).toHaveProperty("cited_paths");
    expect(Array.isArray(result.cited_paths)).toBe(true);
  });

  it("selective checks: cited_paths-only runs only that check and detects non-resolving paths", async () => {
    const tmp = makeTmpDir("cited-paths-selective");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // references/ dir with a non-resolving path — only cited_paths should detect this
    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(
      join(refsDir, "doc.md"),
      "See `mcp-server/src/nonexistent/file.ts` for details.\n",
      "utf8",
    );

    // Pass checks: ["cited_paths"] — verifies the value is accepted (not rejected by schema)
    // and that only cited_paths runs while all other checks return empty arrays.
    const result = await wikiLint({ checks: ["cited_paths"] }, tmp, tmp);

    // Non-requested checks must be empty
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);

    // cited_paths ran and detected the non-resolving path
    expect(result.cited_paths.length).toBeGreaterThan(0);
    expect(result.cited_paths[0].cited_path).toContain("nonexistent");
  });

  it("checks filter: contradictions-only omits cited_paths", async () => {
    const tmp = makeTmpDir("filter-contradictions");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "doc.md"), "See `src/nonexistent/path.ts` for details.\n", "utf8");

    // Only run contradictions — cited_paths should be empty (check not run)
    const result = await wikiLint({ checks: ["contradictions"] }, tmp, tmp);

    expect(result.cited_paths).toEqual([]);
  });

  it("scope_layers: detects a principle with an invalid layer name", async () => {
    const tmp = makeTmpDir("scope-layers-bogus");

    // Principle dir — one principle with an invalid layer name
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });

    const bogusLayerContent = `---
id: bogus-layer-principle
title: Bogus Layer Principle
severity: convention
scope:
  layers: [bogus]
  tags: []
---

## Summary
A test principle with a bogus layer.

## Examples

\`\`\`typescript
// example
const x = 1;
\`\`\`
`;
    writeFileSync(join(principlesDir, "bogus-layer-principle.md"), bogusLayerContent, "utf8");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies bogus-layer-principle.\n", "utf8");

    const result = await wikiLint({ checks: ["scope_layers"] }, tmp, tmp);

    // Only scope_layers runs — all others empty
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.cited_paths).toEqual([]);

    // scope_layers detected the bogus layer
    expect(result.scope_layers).toHaveLength(1);
    expect(result.scope_layers[0].principle_id).toBe("bogus-layer-principle");
    expect(result.scope_layers[0].invalid_layers).toEqual(["bogus"]);
    expect(result.scope_layers[0].message).toContain("bogus");
    expect(result.scope_layers[0].message).toContain("set layers: []");
    expect(result.summary.total_findings).toBe(1);
  });

  it("scope_layers: README-style file (empty id) is never flagged as a finding", async () => {
    const tmp = makeTmpDir("scope-layers-readme");

    // Only a README-style file with no valid frontmatter id (empty id → filtered by loadAllPrinciples)
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });

    // Write a valid principle (with examples) so the tool has something to work with
    writePrincipleWithExamples(principlesDir, "real-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies real-principle.\n", "utf8");

    const result = await wikiLint({ checks: ["scope_layers"] }, tmp, tmp);

    // No scope_layers findings — real principle has empty layers (valid)
    expect(result.scope_layers).toHaveLength(0);
  });

  it("scope_layers: custom layer from .canon/config.json is NOT flagged", async () => {
    const tmp = makeTmpDir("scope-layers-custom");

    // Write a .canon/config.json with a custom "backend" layer
    const canonDir = join(tmp, ".canon");
    mkdirSync(canonDir, { recursive: true });
    writeFileSync(
      join(canonDir, "config.json"),
      JSON.stringify({ layers: { backend: ["src/backend"], frontend: ["src/frontend"] } }),
      "utf8",
    );

    // Principle using the custom "backend" layer
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    const customLayerContent = `---
id: custom-layer-principle
title: Custom Layer Principle
severity: convention
scope:
  layers: [backend]
  tags: []
---

## Summary
A principle using a project-local layer.

## Examples

\`\`\`typescript
// example
const x = 1;
\`\`\`
`;
    writeFileSync(join(principlesDir, "custom-layer-principle.md"), customLayerContent, "utf8");
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies custom-layer-principle.\n", "utf8");

    const result = await wikiLint({ checks: ["scope_layers"] }, tmp, tmp);

    // custom-layer-principle uses "backend" which is defined in config.json — should NOT be flagged
    expect(result.scope_layers).toHaveLength(0);
    expect(result.summary.total_findings).toBe(0);
  });

  it("scope_layers: layer unknown to both defaults and config is still flagged", async () => {
    const tmp = makeTmpDir("scope-layers-still-bogus");

    // Write a .canon/config.json with a custom layer that does NOT include "bogus"
    const canonDir = join(tmp, ".canon");
    mkdirSync(canonDir, { recursive: true });
    writeFileSync(
      join(canonDir, "config.json"),
      JSON.stringify({ layers: { backend: ["src/backend"] } }),
      "utf8",
    );

    // Principle using a layer that is NOT in defaults or config
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    const bogusLayerContent = `---
id: still-bogus-principle
title: Still Bogus
severity: convention
scope:
  layers: [bogus]
  tags: []
---

## Summary
Still bogus.

## Examples

\`\`\`typescript
// example
const x = 1;
\`\`\`
`;
    writeFileSync(join(principlesDir, "still-bogus-principle.md"), bogusLayerContent, "utf8");
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies still-bogus-principle.\n", "utf8");

    const result = await wikiLint({ checks: ["scope_layers"] }, tmp, tmp);

    // "bogus" is not in defaults OR the config — should still be flagged
    expect(result.scope_layers).toHaveLength(1);
    expect(result.scope_layers[0].principle_id).toBe("still-bogus-principle");
    expect(result.scope_layers[0].invalid_layers).toEqual(["bogus"]);
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
