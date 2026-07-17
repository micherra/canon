/**
 * partial-markers — regression coverage for the W-1 adversarial finding.
 *
 * `PARTIAL_MARKERS[2]` (the unanchored, case-insensitive `Verdict:\s*IN_PROGRESS`
 * marker) previously matched anywhere in a document's first 8192 chars,
 * including inside a FINALIZED reviewer body that merely quotes the marker
 * string in prose (e.g. a review OF Canon's own skeleton machinery). That
 * false-positive skeleton classification defeats both `emitWriteReceipt`
 * (skips the receipt) and the WR-02 disk fallback (`hasRealCanonicalFile`,
 * write-receipt.ts) — both consume the shared `isSkeletonContent` — so a
 * legitimate finished review gets hard-rejected by the write-receipt gate.
 *
 * The fix anchors marker [2] to the heading-line form the reviewer's Early
 * Output Protocol stub actually writes (`## Canon Review — Verdict:
 * IN_PROGRESS`, always a line starting with 1-6 `#` characters) so it no
 * longer matches the same substring mid-prose, while genuine stub detection
 * is preserved.
 */

import { describe, expect, it } from "vitest";
import { isSkeletonContent, PARTIAL_MARKERS } from "../partial-markers.ts";

describe("isSkeletonContent — false-positive regression (W-1)", () => {
  it("a finalized review whose body quotes 'Verdict: IN_PROGRESS' mid-prose is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "#### Violations",
      "",
      "| Principle | Severity | Location | Confidence | Description | Fix |",
      "|-----------|----------|----------|------------|--------------|-----|",
      "",
      "#### Honored",
      "",
      "- **agent-artifact-write-before-return**",
      "",
      "#### Score",
      "",
      "| Layer | Rules | Opinions | Conventions |",
      "|-------|-------|----------|-------------|",
      "| overall | 3 / 3 | 2 / 2 | 1 / 1 |",
      "",
      'The Early Output Protocol writes a stub with frontmatter `verdict: "IN_PROGRESS"` and a heading of the form `Verdict: IN_PROGRESS` before any analysis begins.',
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it("a finalized review whose body quotes '## Status: Partial' mid-prose is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "The architect's stub obligation writes `## Status: Partial` as its first heading.",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it("a finalized review whose body quotes 'status: \"IN_PROGRESS\"' mid-prose is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      'The scribe writes `status: "IN_PROGRESS"` in frontmatter as its step-1 skeleton value.',
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it("still detects the genuine reviewer Early Output Protocol stub", () => {
    const content = [
      "---",
      "verdict: IN_PROGRESS",
      "---",
      "",
      "## Canon Review — Verdict: IN_PROGRESS",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(true);
  });

  it("still detects a heading-only stub with no frontmatter (defense-in-depth for marker [2])", () => {
    const content = ["## Canon Review — Verdict: IN_PROGRESS", "", "(no frontmatter yet)"].join(
      "\n",
    );

    expect(isSkeletonContent(content)).toBe(true);
  });

  it("still detects the genuine architect '## Status: Partial' skeleton", () => {
    expect(isSkeletonContent("## Status: Partial\n\nStill researching.\n")).toBe(true);
  });

  it('still detects the genuine scribe status: "IN_PROGRESS" skeleton', () => {
    expect(isSkeletonContent('---\nstatus: "IN_PROGRESS"\n---\n\n## Context Sync\n')).toBe(true);
  });

  it("marker [2] no longer matches the bare substring outside a heading line", () => {
    const marker = PARTIAL_MARKERS[2];
    expect(marker.test("The verdict is: Verdict: IN_PROGRESS, still pending.")).toBe(false);
  });

  it("marker [2] still matches the heading form at line start", () => {
    const marker = PARTIAL_MARKERS[2];
    expect(marker.test("## Canon Review — Verdict: IN_PROGRESS")).toBe(true);
  });
});
