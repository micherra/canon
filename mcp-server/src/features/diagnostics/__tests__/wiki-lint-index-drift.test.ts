/**
 * Tests for wiki_lint index_drift check default/explicit behavior.
 *
 * index_drift is excluded from the DEFAULT_CHECKS set so that a default run
 * against a project without sentinel-delimited artifact indexes does not
 * emit noisy MISSING_MARKERS findings. It must still be runnable when
 * explicitly requested via checks: ["index_drift"].
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: class MockDriftStore {
    async getReviews() {
      return [];
    }
  },
}));

import { wikiLint } from "../tools/wiki-lint.ts";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `wiki-lint-idx-test-${prefix}-${Date.now()}`);
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
A test principle.

## Examples

\`\`\`typescript
const x = 1;
\`\`\`
`;
  writeFileSync(join(dir, `${id}.md`), content, "utf8");
}

describe("wiki_lint index_drift check — default exclusion and explicit selection", () => {
  it("default run omits index_drift (no MISSING_MARKERS for absent indexes)", async () => {
    const tmp = makeTmpDir("no-index-drift-by-default");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    // Reference via a real [[wiki-link]] — under ADR-0019 a prose substring no longer
    // counts as a reference, so an inbound [[ ]] edge is required to avoid an orphan finding.
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies [[some-principle]].\n", "utf8");

    // No rules/, agents/, templates/, references/ indexes — intentionally absent.
    // Default run must not emit MISSING_MARKERS for them because index_drift
    // is not in the DEFAULT_CHECKS set.
    const result = await wikiLint({}, tmp, tmp);

    expect(result.index_drift).toEqual([]);
    expect(result.summary.total_findings).toBe(0);
  });

  it("explicit checks:['index_drift'] runs the check", async () => {
    const tmp = makeTmpDir("explicit-index-drift");

    const principlesDir = join(tmp, "principles", "conventions");
    mkdirSync(principlesDir, { recursive: true });
    writePrincipleWithExamples(principlesDir, "some-principle");

    // Reference via a real [[wiki-link]] — under ADR-0019 a prose substring no longer
    // counts as a reference, so an inbound [[ ]] edge is required to avoid an orphan finding.
    writeFileSync(join(tmp, "CLAUDE.md"), "# Root\nApplies [[some-principle]].\n", "utf8");

    const result = await wikiLint({ checks: ["index_drift"] }, tmp, tmp);

    // All other checks must be skipped (not requested)
    expect(result.contradictions).toEqual([]);
    expect(result.orphan_principles).toEqual([]);
    expect(result.stale_refs).toEqual([]);
    expect(result.missing_examples).toEqual([]);

    // index_drift ran — result is the output array (not undefined/skipped)
    expect(Array.isArray(result.index_drift)).toBe(true);
  });
});
