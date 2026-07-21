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

describe("isSkeletonContent — leading-region scoping (W-2/W-3 round-2 fix)", () => {
  it("a finalized review with a FENCED 'verdict: IN_PROGRESS' line in the body is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "This review discusses the Early Output Protocol stub format below.",
      "",
      "```yaml",
      "verdict: IN_PROGRESS",
      "```",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it('a finalized review with a FENCED status: "IN_PROGRESS" line in the body is NOT a skeleton', () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "This review discusses the scribe stub's frontmatter shape below.",
      "",
      "```",
      'status: "IN_PROGRESS"',
      "```",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it("(W-A, round 3) a BODY '## Status: Partial' heading after substantive prose IS a skeleton — reversed from round 2", () => {
    // Round 2 scoped ALL markers (including [0]) to the leading region, so this
    // case returned false. Round 3 (W-A fix) found that scoping fail-OPEN: a
    // genuine architect/security skeleton commonly writes exactly this shape —
    // one line of prose under the title before its status footer. Marker [0]
    // is now scanned across the whole fence-stripped head, so an UNFENCED
    // '## Status: Partial' heading anywhere is always treated as a skeleton,
    // even in this adversarial phrasing where a finished review's prose
    // happens to precede a real heading quoting the marker. This is the
    // accepted false-positive direction (asymmetric risk: never miss a real
    // skeleton) — see the module doc comment's "Known accepted residual".
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "The architect's Early Output Protocol stub writes a heading below as its first line.",
      "",
      "## Status: Partial",
      "",
      "That heading text is quoted verbatim from the stub template, not a real skeleton.",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(W-3) a body heading that merely quotes 'Verdict: IN_PROGRESS' after substantive prose is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "Round-1 anchored only PARTIAL_MARKERS[2] to a heading-line form, described below.",
      "",
      "### Marker [2]: the reviewer stub heading `## Canon Review — Verdict: IN_PROGRESS`",
      "",
      "This finding explains why that anchoring alone was insufficient.",
      "",
    ].join("\n");

    expect(isSkeletonContent(content)).toBe(false);
  });

  it("still detects the genuine architect '## Status: Partial' stub with a preceding title heading (multi-heading leading region)", () => {
    expect(isSkeletonContent("# Design\n\n## Status: Partial\n\n## Approach\n")).toBe(true);
  });
});

describe("isSkeletonContent — two-class scan, W-A fail-open fix (round 3)", () => {
  // The 8 numbered cases below are the acceptance tests for the round-3 fix:
  // marker [0] (`## Status: Partial`) now scans the WHOLE fence-stripped head
  // instead of only the leading region, so a genuine architect/security
  // skeleton is still caught even when its status footer follows body prose.
  // Fenced code blocks are stripped first so this whole-head scan cannot
  // reopen the W-2 fenced-example false positive.

  it("(case 1) reviewer stub — frontmatter + heading, no prose — IS a skeleton", () => {
    const content = [
      "---",
      "verdict: IN_PROGRESS",
      "---",
      "",
      "## Canon Review — Verdict: IN_PROGRESS",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(case 2, the W-A regression) architect skeleton with prose BEFORE the '## Status: Partial' marker IS a skeleton", () => {
    const content = ["# Design", "", "being drafted.", "", "## Status: Partial"].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(case 3, the W-A regression) security skeleton — frontmatter + prose before the marker — IS a skeleton", () => {
    const content = [
      "---",
      "agent: security",
      "---",
      "",
      "### Summary",
      "",
      "underway.",
      "",
      "## Status: Partial",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(case 4) scribe stub — frontmatter only, no trailing heading — IS a skeleton", () => {
    const content = ["---", 'status: "IN_PROGRESS"', "---"].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(case 5) architect skeleton — marker right after the title, no prose — IS a skeleton", () => {
    const content = ["# Design", "", "## Status: Partial"].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("(case 6) finished review — body prose mentions 'Verdict: IN_PROGRESS' mid-sentence — is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: CLEAN",
      "---",
      "",
      "## Canon Review — Verdict: CLEAN",
      "",
      "The stub reports Verdict: IN_PROGRESS while analysis is underway.",
      "",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(false);
  });

  it("(case 7) finished review — a FENCED '## Status: Partial' line in the body — is NOT a skeleton (verifies fence-stripping protects the new whole-head marker-[0] scan)", () => {
    // This is the exact W-2 regression shape: a finalized review illustrating
    // the architect's skeleton marker inside a fence. Moving marker [0] to a
    // whole-head scan (case 2/3 above) would reopen this false positive
    // without fence-stripping running first.
    const content = [
      "---",
      "verdict: BLOCKING",
      "---",
      "",
      "## Canon Review — Verdict: BLOCKING",
      "",
      "The architect's Early Output Protocol writes a skeleton like this:",
      "",
      "```",
      "## Status: Partial",
      "```",
      "",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(false);
  });

  it("(case 8) finished review — real frontmatter verdict + long body — is NOT a skeleton", () => {
    const content = [
      "---",
      "verdict: WARNING",
      "---",
      "",
      "## Canon Review — Verdict: WARNING",
      "",
      "#### Violations",
      "",
      "| Principle | Severity | Location | Confidence | Description | Fix |",
      "|-----------|----------|----------|------------|--------------|-----|",
      "| some-rule | WARNING | src/foo.ts:12 | high | Missing null check | Add a guard clause |",
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
      "This review covers several files and stages of analysis in detail, none of which resemble a skeleton marker.",
      "",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(false);
  });
});

describe("isSkeletonContent — frontmatter anchor tolerates BOM/leading-blank/leading-space (Finding A, round 4)", () => {
  // FRONTMATTER_FENCE was `^---\r?\n[\s\S]*?\r?\n---\r?\n?` with no `m` flag —
  // `^` required the opening `---` at byte 0 of the scanned head. A leading
  // BOM (U+FEFF, `write_context_sync`/raw-`Write` write `input.content`
  // verbatim, no byte-0 render guarantee), a leading blank line, or leading
  // spaces before `---` all defeated the match, so `extractLeadingRegion`
  // never reached the real frontmatter — a genuine scribe/reviewer skeleton
  // (markers [1]/[3], and [2] via its frontmatter backstop) went undetected.
  // That is the dangerous fail-OPEN direction this module exists to avoid.

  it("BOM + scribe frontmatter — IS a skeleton", () => {
    const content = ["﻿---", 'status: "IN_PROGRESS"', "---", ""].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("leading blank line + scribe frontmatter — IS a skeleton", () => {
    const content = ["", "---", 'status: "IN_PROGRESS"', "---", ""].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("leading blank line + reviewer verdict frontmatter + heading — IS a skeleton", () => {
    const content = [
      "",
      "---",
      "verdict: IN_PROGRESS",
      "---",
      "",
      "## Canon Review — Verdict: IN_PROGRESS",
      "",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("BOM + reviewer stub — IS a skeleton", () => {
    const content = [
      "﻿---",
      "verdict: IN_PROGRESS",
      "---",
      "",
      "## Canon Review — Verdict: IN_PROGRESS",
      "",
    ].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });

  it("leading spaces before the opening fence + scribe frontmatter — IS a skeleton", () => {
    const content = ["   ---", 'status: "IN_PROGRESS"', "---", ""].join("\n");
    expect(isSkeletonContent(content)).toBe(true);
  });
});
