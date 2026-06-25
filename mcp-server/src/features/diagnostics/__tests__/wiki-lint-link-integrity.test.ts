/**
 * Tool-wiring integration tests for the `link_integrity` wiki_lint check (R2,
 * ADR-0019). Exercises the `wikiLint()` handler end-to-end via a temp-dir project
 * fixture — confirms that the check is dispatched, produces findings for broken
 * `[[wiki-links]]`, dangling `ADR-NNNN` refs, and is included in default runs.
 *
 * Unit tests for the pure service (`extractLinks`, `buildLinkGraph`) live in
 * `services/__tests__/link-graph.test.ts`; those are not duplicated here. The P2
 * fenced-code-block exclusion is tested here through the full wiring to verify the
 * contract holds end-to-end.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock DriftStore before importing the tool handler.
vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: class MockDriftStore {
    async getReviews() {
      return [];
    }
  },
}));

import { wikiLint } from "../tools/wiki-lint.ts";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `wiki-lint-link-integrity-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a minimal valid principle with an Examples section. */
function writePrincipleWithExamples(dir: string, id: string): void {
  writeFileSync(
    join(dir, `${id}.md`),
    `---
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
`,
    "utf8",
  );
}

describe("wikiLint link_integrity check (tool wiring)", () => {
  it("checks:['link_integrity'] flags BROKEN_WIKILINK for a [[target]] that resolves to no known id or stem", async () => {
    const tmp = makeTmpDir("broken-wiki");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "real-principle");

    // A references/ doc linking to a non-existent principle id.
    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(
      join(refsDir, "doc.md"),
      "# References\n\nSee [[non-existent-principle]] for details.\n",
      "utf8",
    );

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["link_integrity"] }, tmp, tmp);

    // Non-requested checks must be empty.
    expect(result.contradictions).toEqual([]);
    expect(result.missing_examples).toEqual([]);
    expect(result.orphan_principles).toEqual([]);

    // link_integrity ran and flagged the broken wiki-link.
    expect(Array.isArray(result.link_integrity)).toBe(true);
    const broken = result.link_integrity.filter((f) => f.code === "BROKEN_WIKILINK");
    expect(broken.length).toBeGreaterThan(0);
    expect(broken[0].target).toBe("non-existent-principle");
    expect(result.summary.total_findings).toBeGreaterThan(0);
  });

  it("[[id]] inside a fenced code block is NOT flagged as BROKEN_WIKILINK (P2 exclusion end-to-end)", async () => {
    // This test closes the gap between the pure-service P2 unit test and the full
    // wiring path: the mdast text-node visitor must exclude code nodes even when
    // invoked through buildCorpusLinkGraph → buildLinkGraph → extractLinks.
    const tmp = makeTmpDir("code-block-exclusion");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "real-principle");

    // The only `[[...]]` in this doc is inside a fenced code block.
    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(
      join(refsDir, "code-only.md"),
      [
        "# Code Only",
        "",
        "```ts",
        "// [[in-code-not-a-link]]",
        "```",
        "",
        "Real prose with no wiki-links.",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["link_integrity"] }, tmp, tmp);

    // No BROKEN_WIKILINK findings: the code-block occurrence must not be extracted.
    const broken = result.link_integrity.filter((f) => f.code === "BROKEN_WIKILINK");
    expect(broken).toHaveLength(0);
  });

  it("dangling ADR-NNNN reference is flagged as DANGLING_ADR_REF through wiring", async () => {
    const tmp = makeTmpDir("dangling-adr");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "real-principle");

    // A doc referencing a nonexistent ADR number.
    const refsDir = join(tmp, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(
      join(refsDir, "adr-ref.md"),
      "# ADR Ref\n\nSee ADR-9999 for the decision.\n",
      "utf8",
    );

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["link_integrity"] }, tmp, tmp);

    const dangling = result.link_integrity.filter((f) => f.code === "DANGLING_ADR_REF");
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling[0].target).toBe("9999");
  });

  it("default run (no checks filter) includes link_integrity in output", async () => {
    const tmp = makeTmpDir("default-run");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "real-principle");

    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "test-agent.md"),
      "---\nname: test\ndescription: A test agent.\nmodel: sonnet\nrules: []\n---\n\nApplies real-principle.\n",
      "utf8",
    );

    writeFileSync(
      join(tmp, "CLAUDE.md"),
      "# Clean\nUse [[real-principle]] as your guide.\n",
      "utf8",
    );

    const result = await wikiLint({}, tmp, tmp);

    // link_integrity key must be present and array-typed in the default run output.
    expect(result).toHaveProperty("link_integrity");
    expect(Array.isArray(result.link_integrity)).toBe(true);
  });
});
