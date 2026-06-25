/**
 * Tool-wiring integration tests for the `frontmatter_schema` wiki_lint check (R1,
 * ADR-0021). Exercises the `wikiLint()` handler end-to-end via a temp-dir project
 * fixture — confirms that the check is dispatched, produces findings for malformed
 * artifact frontmatter, and is included in default (no-filter) runs.
 *
 * Unit tests for the pure service (`checkFrontmatterSchema`, `classifyFmClass`) live
 * in `services/__tests__/frontmatter-schema.test.ts`; those are not duplicated here.
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
  const dir = join(tmpdir(), `wiki-lint-fm-schema-${prefix}-${Date.now()}`);
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

describe("wikiLint frontmatter_schema check (tool wiring)", () => {
  it("checks:['frontmatter_schema'] produces SCHEMA_ERROR for a principle with a typo'd severity", async () => {
    const tmp = makeTmpDir("wiring-bad-severity");

    // pluginDir = tmp so the tool scans tmp/principles/ for schema-bearing artifacts.
    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });

    writePrincipleWithExamples(principlesDir, "clean-principle");

    // Malformed principle — severity is not one of rule/strong-opinion/convention.
    writeFileSync(
      join(principlesDir, "bad-severity-principle.md"),
      `---
id: bad-severity-principle
title: Bad Severity
severity: not-valid
scope:
  layers: []
  tags: []
---

## Summary
A principle with a bad severity.
`,
      "utf8",
    );

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["frontmatter_schema"] }, tmp, tmp);

    // Non-requested checks must be empty.
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);

    // frontmatter_schema ran and detected the bad severity.
    expect(Array.isArray(result.frontmatter_schema)).toBe(true);
    expect(result.frontmatter_schema.length).toBeGreaterThan(0);
    const finding = result.frontmatter_schema.find((f) =>
      f.file_path.includes("bad-severity-principle"),
    );
    expect(finding).toBeDefined();
    expect(finding?.code).toBe("SCHEMA_ERROR");
    expect(finding?.message).toMatch(/severity/);
    expect(result.summary.total_findings).toBeGreaterThan(0);
  });

  it("checks:['frontmatter_schema'] produces SCHEMA_ERROR for an agent missing required 'name'", async () => {
    const tmp = makeTmpDir("wiring-bad-agent");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "clean-principle");

    // agents/ tree is scanned from pluginDir (= tmp here).
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir, { recursive: true });
    // Malformed agent: 'name' is missing.
    writeFileSync(
      join(agentsDir, "no-name-agent.md"),
      "---\ndescription: An agent without a name.\nmodel: sonnet\nrules: []\n---\n\nBody.\n",
      "utf8",
    );

    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\n", "utf8");

    const result = await wikiLint({ checks: ["frontmatter_schema"] }, tmp, tmp);

    expect(Array.isArray(result.frontmatter_schema)).toBe(true);
    const agentFinding = result.frontmatter_schema.find((f) =>
      f.file_path.includes("no-name-agent"),
    );
    expect(agentFinding).toBeDefined();
    expect(agentFinding?.code).toBe("SCHEMA_ERROR");
    expect(agentFinding?.message).toMatch(/name/);
  });

  it("default run (no checks filter) includes frontmatter_schema in output", async () => {
    const tmp = makeTmpDir("wiring-default-run");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "clean-principle");

    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir, { recursive: true });
    // Schema-valid agent so the default run stays CLEAN for frontmatter_schema.
    writeFileSync(
      join(agentsDir, "test-agent.md"),
      "---\nname: test\ndescription: A test agent.\nmodel: sonnet\nrules: []\n---\n\nApplies clean-principle.\n",
      "utf8",
    );

    writeFileSync(
      join(tmp, "CLAUDE.md"),
      "# Clean\nUse [[clean-principle]] as your guide.\n",
      "utf8",
    );

    const result = await wikiLint({}, tmp, tmp);

    // frontmatter_schema key must be present in the default run output.
    expect(result).toHaveProperty("frontmatter_schema");
    expect(Array.isArray(result.frontmatter_schema)).toBe(true);
  });
});
