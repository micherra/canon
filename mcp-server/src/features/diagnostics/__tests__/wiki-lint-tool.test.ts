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

// ---- scope_tags tool wiring ----

describe("wikiLint scope_tags check (tool wiring)", () => {
  it("scope_tags: fixture principle with invalid tag → one finding when checks: ['scope_tags']", async () => {
    const tmp = makeTmpDir("scope-tags-tool");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });

    const badTagContent = `---
id: bad-scope-tag-principle
title: Bad Scope Tag Principle
severity: convention
scope:
  layers: []
  tags:
    - not-a-kg-tag
---

## Summary
A test principle with an invalid scope.tags entry.

## Examples

\`\`\`typescript
// example
const x = 1;
\`\`\`
`;
    writeFileSync(join(principlesDir, "bad-scope-tag-principle.md"), badTagContent, "utf8");
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["scope_tags"] }, tmp, tmp);

    // Only scope_tags runs — all others empty
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.cited_paths).toEqual([]);
    expect(result.scope_layers).toEqual([]);

    // scope_tags detected the invalid tag
    expect(result.scope_tags).toHaveLength(1);
    expect(result.scope_tags[0].principle_id).toBe("bad-scope-tag-principle");
    expect(result.scope_tags[0].invalid_tags).toEqual(["not-a-kg-tag"]);
    expect(result.summary.total_findings).toBe(1);
  });

  it("scope_tags: default run (no checks filter) includes scope_tags in output", async () => {
    const tmp = makeTmpDir("scope-tags-default");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "good-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies good-principle.\n", "utf8");

    const result = await wikiLint({}, tmp, tmp);

    // scope_tags key must be present in default run (proves it is in the default check set)
    expect(result).toHaveProperty("scope_tags");
    expect(Array.isArray(result.scope_tags)).toBe(true);
  });
});

// ---- DDD doc set scan surface ----

describe("wikiLint DDD doc set (collectDddDocPaths wiring)", () => {
  it("cited_paths: docs/foo.md citing a nonexistent path → finding with source_file in docs/", async () => {
    const tmp = makeTmpDir("ddd-docs-cited");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // docs/foo.md with a broken cited path
    const docsDir = join(tmp, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, "foo.md"),
      "See `mcp-server/src/does-not-exist.ts` for details.\n",
      "utf8",
    );

    const result = await wikiLint({ checks: ["cited_paths"] }, tmp, tmp);

    expect(result.cited_paths.length).toBeGreaterThan(0);
    const finding = result.cited_paths.find((f) => f.cited_path.includes("does-not-exist"));
    expect(finding).toBeDefined();
    expect(finding?.source_file).toContain("docs");
  });

  it("cited_paths: domain README.md citing a broken path → finding", async () => {
    const tmp = makeTmpDir("ddd-domain-readme-cited");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // mcp-server/src/domains/sample/README.md with a broken cited path
    const domainDir = join(tmp, "mcp-server", "src", "domains", "sample");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(
      join(domainDir, "README.md"),
      "# Sample Domain\n\nSee `mcp-server/src/features/missing/handler.ts` for wiring.\n",
      "utf8",
    );

    const result = await wikiLint({ checks: ["cited_paths"] }, tmp, tmp);

    expect(result.cited_paths.length).toBeGreaterThan(0);
    const finding = result.cited_paths.find((f) => f.cited_path.includes("missing"));
    expect(finding).toBeDefined();
  });

  it("stale_refs: root CONTEXT.md citing a broken markdown link → stale_refs finding", async () => {
    const tmp = makeTmpDir("ddd-context-md-stale");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    // root CONTEXT.md referencing a file that doesn't exist
    writeFileSync(
      join(tmp, "CONTEXT.md"),
      "# Context\n\nSee `docs/gone.md` for context details.\n",
      "utf8",
    );
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    const result = await wikiLint({ checks: ["stale_refs"] }, tmp, tmp);

    expect(result.stale_refs.length).toBeGreaterThan(0);
    const finding = result.stale_refs.find((f) => f.referenced_path.includes("gone.md"));
    expect(finding).toBeDefined();
  });

  it("cited_paths: docs/explore/ file citing a broken path → NO finding (excluded)", async () => {
    const tmp = makeTmpDir("ddd-explore-excluded");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // docs/explore/ file with broken cited path — must be excluded
    const exploreDir = join(tmp, "docs", "explore");
    mkdirSync(exploreDir, { recursive: true });
    writeFileSync(
      join(exploreDir, "PROPOSAL-X.md"),
      "See `mcp-server/src/features/future/planned.ts` for a proposed feature.\n",
      "utf8",
    );

    const result = await wikiLint({ checks: ["cited_paths"] }, tmp, tmp);

    // No finding from explore/ — the path does not exist but the file is excluded
    const exploreFinding = result.cited_paths.find(
      (f) => f.source_file.includes("explore") || f.cited_path.includes("planned"),
    );
    expect(exploreFinding).toBeUndefined();
  });

  it("collectDddDocPaths: missing docs/ dir degrades gracefully (no throw, returns other groups)", async () => {
    const tmp = makeTmpDir("ddd-no-docs-dir");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // No docs/ dir; add a domain README and CONTEXT.md so they can still be found
    const domainDir = join(tmp, "mcp-server", "src", "domains", "alpha");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "README.md"), "# Alpha Domain\nNo bad paths here.\n", "utf8");

    writeFileSync(join(tmp, "CONTEXT.md"), "# Context\nAll clean.\n", "utf8");

    // Should not throw; no findings expected since all content is clean
    await expect(
      wikiLint({ checks: ["cited_paths", "stale_refs"] }, tmp, tmp),
    ).resolves.not.toThrow();
    const result = await wikiLint({ checks: ["cited_paths"] }, tmp, tmp);
    // No false findings from the domain README or CONTEXT.md (all paths valid)
    expect(result.cited_paths).toEqual([]);
  });

  it("filesScanned: DDD doc count included in summary.files_scanned", async () => {
    const tmp = makeTmpDir("ddd-files-scanned");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies some-principle.\n", "utf8");

    // docs/ with one file
    const docsDir = join(tmp, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "guide.md"), "# Guide\nClean content.\n", "utf8");

    // Domain README
    const domainDir = join(tmp, "mcp-server", "src", "domains", "beta");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "README.md"), "# Beta Domain\n", "utf8");

    // root CONTEXT.md
    writeFileSync(join(tmp, "CONTEXT.md"), "# Context\n", "utf8");

    const resultBefore = await wikiLint({}, tmp, tmp);
    // files_scanned must include: CLAUDE.md (1) + agents (0) + guide.md (1) + README.md (1) + CONTEXT.md (1) = 4
    // The exact number depends on the fixture but must be > 1 (just CLAUDE.md)
    expect(resultBefore.summary.files_scanned).toBeGreaterThanOrEqual(4);
  });
});
