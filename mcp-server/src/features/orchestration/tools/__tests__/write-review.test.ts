/**
 * write-review.ts tests — confidence adapter integration
 *
 * Tests that writeReview correctly handles the optional confidenceAdapter:
 * - Backward compat: no confidenceAdapter → violations without confidence
 * - With adapter: populates missing confidence
 * - Pre-existing confidence is preserved (not overwritten)
 * - Generated markdown includes Confidence column
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { ConfidenceAnnotation } from "@shared/lib/confidence.ts";
import { afterEach, describe, expect, it } from "vitest";
import { seedExecution } from "../../__tests__/seed-execution-test-helper.ts";
import { type ConfidenceAdapter, type WriteReviewInput, writeReview } from "../write-review.ts";

// ---- Helpers ----

async function makeTmpWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "write-review-test-"));
  seedExecution(workspace);
  return workspace;
}

const baseInput: WriteReviewInput = {
  workspace: "", // filled in per test
  slug: "test-slug",
  verdict: "changes_required",
  violations: [
    {
      principle_id: "errors-are-values",
      severity: "rule",
      file_path: "src/foo.ts",
    },
  ],
  honored: ["simplicity-first"],
  score: {
    rules: { passed: 3, total: 4 },
    opinions: { passed: 5, total: 5 },
    conventions: { passed: 2, total: 3 },
  },
  files: ["src/foo.ts"],
};

const highConfidence: ConfidenceAnnotation = {
  score: 0.85,
  tier: "high",
  basis: [{ signal: "violation_history", weight: 1.0, detail: "violated 10 times" }],
  sample_size: 20,
};

const mockAdapter: ConfidenceAdapter = {
  computeViolationConfidence: () => highConfidence,
};

const tmpDirs: string[] = [];

afterEach(async () => {
  const dirs = tmpDirs.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// ---- Tests ----

describe("writeReview — backward compatibility (no confidenceAdapter)", () => {
  it("produces violations without confidence field", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const result = await writeReview({ ...baseInput, workspace });
    expect(result.ok).toBe(true);
    // Violations in meta.json should not have confidence
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toBeUndefined();
  });
});

describe("writeReview — with confidenceAdapter", () => {
  it("adds confidence to violations that lack it", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const result = await writeReview({ ...baseInput, workspace }, undefined, mockAdapter);
    expect(result.ok).toBe(true);
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toEqual(highConfidence);
  });

  it("preserves pre-existing confidence on violations (does not overwrite)", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const existingConfidence: ConfidenceAnnotation = {
      score: 0.3,
      tier: "low",
      basis: [{ signal: "pre_existing", weight: 1.0, detail: "already set" }],
      sample_size: 5,
    };
    const input: WriteReviewInput = {
      ...baseInput,
      workspace,
      violations: [
        {
          principle_id: "errors-are-values",
          severity: "rule",
          file_path: "src/foo.ts",
          confidence: existingConfidence,
        },
      ],
    };
    // Even with adapter, pre-existing confidence must be preserved
    const result = await writeReview(input, undefined, mockAdapter);
    expect(result.ok).toBe(true);
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toEqual(existingConfidence);
  });

  it("generated markdown includes Confidence column", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    await writeReview({ ...baseInput, workspace }, undefined, mockAdapter);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).toContain(
      "| Principle | Severity | Location | Confidence | Description | Fix |",
    );
    expect(markdown).toContain("HIGH");
  });
});

describe("writeReview — body prose param (dc-03)", () => {
  it("renders the body verbatim after the Score section when provided", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const body =
      "### Code Quality (Advisory)\n\nLooks solid.\n\n### Acceptance Criteria Verification\n\nAC 1: met.\n";
    const result = await writeReview({ ...baseInput, workspace, body });
    expect(result.ok).toBe(true);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    const scoreIdx = markdown.indexOf("#### Score");
    const bodyIdx = markdown.indexOf("### Code Quality (Advisory)");
    expect(scoreIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(scoreIdx);
    expect(markdown).toContain(body.trimEnd());
  });

  it("omits any body section when body is not provided (backward compat)", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    await writeReview({ ...baseInput, workspace });
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).not.toContain("### Code Quality");
    // Exactly one trailing newline — no extra blank lines from an absent body.
    expect(markdown.endsWith("\n\n")).toBe(false);
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("persists body into meta.json when provided; omits the key when absent", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const body = "### Code Quality (Advisory)\n\nLooks solid.\n";
    await writeReview({ ...baseInput, workspace, body });
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.body).toBe(body);

    const workspace2 = await makeTmpWorkspace();
    tmpDirs.push(workspace2);
    await writeReview({ ...baseInput, workspace: workspace2 });
    const meta2 = JSON.parse(
      await readFile(join(workspace2, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect("body" in meta2).toBe(false);
  });

  it("an explicit empty-string body is treated identically to an absent body (no section rendered)", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    await writeReview({ ...baseInput, workspace, body: "" });
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).not.toContain("### Code Quality");
    expect(markdown.endsWith("\n\n")).toBe(false);
    expect(markdown.endsWith("\n")).toBe(true);
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    // Falsy body ("") takes the same `input.body ? ... : {}` branch as absent.
    expect("body" in meta).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: the writeReview -> emitWriteReceipt boundary (agent-integration-boundary-check).
//
// partial-markers.test.ts exhaustively covers `isSkeletonContent` in isolation
// against hand-built strings. None of those tests — nor write-review.test.ts's
// own body-prose tests above — exercise the boundary this build actually
// ships: does a REAL `writeReview` call's generated markdown (real
// frontmatter + heading + violations/honored/score tables + optional body)
// get correctly classified by the finalized-only receipt guard inside
// `emitWriteReceipt`? Two real-tool paths are exercised here that no
// existing test reaches:
//   1. `verdict: "pending"` is the actual reviewer Early Output Protocol stub
//      — VERDICT_MAP maps it to "IN_PROGRESS", so a real writeReview call
//      produces the genuine skeleton frontmatter+heading, not a hand-rolled
//      fixture string.
//   2. A finished review's `body` param that quotes skeleton marker strings
//      (fenced and unfenced) lands well past the frontmatter/first-heading
//      leading region that generateMarkdown() always produces first — this
//      is the shape the "quoting the marker inside a real review" scenario
//      (watch_reviewer_thin_artifact_first_pass's own regression history)
//      actually takes when driven through the real tool, not a synthetic one.
// ---------------------------------------------------------------------------
describe("writeReview -> emitWriteReceipt integration (skeleton detection at the real boundary)", () => {
  it("verdict: 'pending' (the real reviewer Early Output Protocol stub) does NOT emit a write_receipt", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const result = await writeReview({ ...baseInput, workspace, verdict: "pending" });
    expect(result.ok).toBe(true);

    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    // Sanity: this is genuinely the stub shape, produced by the real tool.
    expect(markdown).toContain("verdict: IN_PROGRESS");
    expect(markdown).toContain("## Canon Review — Verdict: IN_PROGRESS");

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);
  });

  it("a finished review whose body quotes 'Verdict: IN_PROGRESS' mid-prose (unfenced) still emits a write_receipt", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const body =
      "### Findings\n\nThe reviewer stub prints `## Canon Review — Verdict: IN_PROGRESS` " +
      "while still researching; that heading is expected mid-run and is not itself a defect.\n";
    const result = await writeReview({ ...baseInput, workspace, verdict: "approved", body });
    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    const receipts = store.getEvents({ type: "write_receipt" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payload.artifact_kind).toBe("review");
  });

  it("a finished review whose body quotes '## Status: Partial' inside a FENCED example still emits a write_receipt", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const body =
      "### Findings\n\nA genuine skeleton looks like:\n\n```markdown\n## Status: Partial\n```\n\nThis review is not one.\n";
    const result = await writeReview({ ...baseInput, workspace, verdict: "approved", body });
    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    const receipts = store.getEvents({ type: "write_receipt" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payload.artifact_kind).toBe("review");
  });

  it("documents the accepted residual: an UNFENCED '## Status: Partial' heading in the body IS misclassified as a skeleton (no receipt)", async () => {
    // Per partial-markers.ts's module doc: marker [0] is scanned across the
    // WHOLE fence-stripped head by design (the W-A fix), so a real review
    // that quotes this exact heading string unfenced in its body will
    // false-positive as a skeleton. This is a documented, accepted residual
    // (asymmetric-risk: a missed genuine skeleton is worse than this rare
    // false positive) — this test pins that behavior at the real writeReview
    // boundary so a future change to the scan doesn't silently flip it
    // without a reviewer noticing the semantics changed.
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const body = "### Findings\n\n## Status: Partial\n\nThat heading string, unfenced, in prose.\n";
    const result = await writeReview({ ...baseInput, workspace, verdict: "approved", body });
    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);
  });
});

describe("writeReview — Description/Fix violation columns (dc-04)", () => {
  it("renders description and fix cells for a violation that has both", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const input: WriteReviewInput = {
      ...baseInput,
      workspace,
      violations: [
        {
          principle_id: "errors-are-values",
          severity: "rule",
          file_path: "src/foo.ts",
          description: "throws instead of returning",
          fix: "return a ToolResult error",
        },
      ],
    };
    await writeReview(input);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).toContain("throws instead of returning");
    expect(markdown).toContain("return a ToolResult error");
  });

  it("renders an em-dash placeholder when description/fix are absent", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    // A fresh violation object (not baseInput's shared, potentially
    // adapter-mutated array — see the confidenceAdapter tests above).
    const input: WriteReviewInput = {
      ...baseInput,
      workspace,
      violations: [
        { principle_id: "errors-are-values", severity: "rule", file_path: "src/foo.ts" },
      ],
    };
    await writeReview(input);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    const row = markdown
      .split("\n")
      .find((line) => line.includes("errors-are-values") && line.startsWith("|"));
    expect(row).toBeDefined();
    expect(row).toMatch(/\|\s*—\s*\|\s*—\s*\|\s*$/);
  });

  it("escapes pipe characters in description via escapeMdCell", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const input: WriteReviewInput = {
      ...baseInput,
      workspace,
      violations: [
        {
          principle_id: "errors-are-values",
          severity: "rule",
          file_path: "src/foo.ts",
          description: "returns a | b instead of an error",
        },
      ],
    };
    await writeReview(input);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).toContain("returns a &#124; b instead of an error");
  });
});
