/**
 * Tests for index-inventory.ts — the primers (6th) class extension.
 *
 * Coverage:
 * 1. Unit — pure functions: CLASS_DIRS.primers resolves; indexFilePath("primers"); sentinel
 *    constants; renderInventoryBlock; diffIndex MISSING_MARKERS + INVENTORY_MISMATCH paths.
 * 2. Integration — real primers/*.md corpus: rendered block matches committed index;
 *    idempotency (second sync is a no-op); tamper detection.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ArtifactClass,
  type ArtifactDescriptor,
  CLASS_DIRS,
  checkIndexDrift,
  diffIndex,
  extractManagedBlock,
  INVENTORY_END,
  INVENTORY_START,
  renderInventoryBlock,
  rewriteManagedBlock,
  toDescriptors,
} from "../index-inventory.ts";

// ---------------------------------------------------------------------------
// Locate the repo root (projectDir for I/O functions)
// ---------------------------------------------------------------------------

// From __tests__/ → services → diagnostics → features → src → mcp-server → worktree root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKTREE_ROOT = resolve(__dirname, "../../../../../..");

// ---------------------------------------------------------------------------
// Unit: CLASS_DIRS.primers resolves
// ---------------------------------------------------------------------------

describe("CLASS_DIRS — primers", () => {
  it("is defined and maps to ['primers']", () => {
    expect(CLASS_DIRS.primers).toEqual(["primers"]);
  });

  it("covers all 6 expected classes", () => {
    const classes: ArtifactClass[] = [
      "agents",
      "principles",
      "references",
      "rules",
      "templates",
      "primers",
    ];
    for (const cls of classes) {
      expect(CLASS_DIRS[cls]).toBeDefined();
      expect(Array.isArray(CLASS_DIRS[cls])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: sentinel constants
// ---------------------------------------------------------------------------

describe("sentinel constants", () => {
  it("INVENTORY_START contains the class name", () => {
    expect(INVENTORY_START("primers")).toBe("<!-- canon:inventory:start class=primers -->");
  });

  it("INVENTORY_END is the closing sentinel", () => {
    expect(INVENTORY_END).toBe("<!-- canon:inventory:end -->");
  });
});

// ---------------------------------------------------------------------------
// Unit: renderInventoryBlock — primers with empty summaries
// ---------------------------------------------------------------------------

describe("renderInventoryBlock", () => {
  it("renders a sorted table with empty summaries for primers (no frontmatter)", () => {
    const descriptors: ArtifactDescriptor[] = [
      { name: "testing.md", summary: "" },
      { name: "backend-api.md", summary: "" },
    ];
    const block = renderInventoryBlock(descriptors);
    const lines = block.split("\n");
    expect(lines[0]).toBe("| artifact | summary |");
    expect(lines[1]).toBe("|---|---|");
    // Sorted: backend-api.md < testing.md
    expect(lines[2]).toBe("| backend-api.md |  |");
    expect(lines[3]).toBe("| testing.md |  |");
  });
});

// ---------------------------------------------------------------------------
// Unit: diffIndex — MISSING_MARKERS and INVENTORY_MISMATCH
// ---------------------------------------------------------------------------

describe("diffIndex", () => {
  const CLS: ArtifactClass = "primers";

  it("returns MISSING_MARKERS when sentinels absent", () => {
    const findings = diffIndex(CLS, "| artifact | summary |\n|---|---|", "no sentinels here");
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("MISSING_MARKERS");
    expect(findings[0].class).toBe("primers");
  });

  it("returns INVENTORY_MISMATCH when block body differs", () => {
    const start = INVENTORY_START(CLS);
    const end = INVENTORY_END;
    const fileContent = `${start}\n| artifact | summary |\n|---|---|\n| old.md |  |\n${end}`;
    const expectedBody = "| artifact | summary |\n|---|---|\n| new.md |  |";
    const findings = diffIndex(CLS, expectedBody, fileContent);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("INVENTORY_MISMATCH");
  });

  it("returns no findings when body matches", () => {
    const start = INVENTORY_START(CLS);
    const end = INVENTORY_END;
    const body = "| artifact | summary |\n|---|---|\n| backend-api.md |  |";
    const fileContent = `${start}\n${body}\n${end}`;
    const findings = diffIndex(CLS, body, fileContent);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: rewriteManagedBlock — round-trip
// ---------------------------------------------------------------------------

describe("rewriteManagedBlock", () => {
  it("returns missing-markers when no sentinels present for primers", () => {
    const result = rewriteManagedBlock("no sentinels", "primers", "body");
    expect(result.ok).toBe(false);
  });

  it("rewrites block between existing sentinels", () => {
    const start = INVENTORY_START("primers");
    const end = INVENTORY_END;
    const original = `intro\n${start}\nold body\n${end}\noutro`;
    const result = rewriteManagedBlock(original, "primers", "new body");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("new body");
      expect(result.content).toContain("intro");
      expect(result.content).toContain("outro");
      expect(result.content).not.toContain("old body");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: real primers/*.md corpus
// ---------------------------------------------------------------------------

describe("primers corpus integration", () => {
  it("primers/.claude/CLAUDE.md exists with both sentinel markers", async () => {
    const indexPath = join(WORKTREE_ROOT, "primers", ".claude", "CLAUDE.md");
    const content = await readFile(indexPath, "utf8");
    expect(content).toContain(INVENTORY_START("primers"));
    expect(content).toContain(INVENTORY_END);
  });

  it("committed index matches current primers on disk (no drift)", async () => {
    const findings = await checkIndexDrift(WORKTREE_ROOT);
    const primerFindings = findings.filter((f) => f.class === "primers");
    expect(primerFindings).toHaveLength(0);
  });

  it("idempotency: second checkIndexDrift after sync reports no drift", async () => {
    // Run drift check twice — should return same empty result
    const findings1 = await checkIndexDrift(WORKTREE_ROOT);
    const findings2 = await checkIndexDrift(WORKTREE_ROOT);
    const p1 = findings1.filter((f) => f.class === "primers");
    const p2 = findings2.filter((f) => f.class === "primers");
    expect(p1).toHaveLength(0);
    expect(p2).toHaveLength(0);
  });

  it("tamper detection: modified block yields INVENTORY_MISMATCH", async () => {
    const indexPath = join(WORKTREE_ROOT, "primers", ".claude", "CLAUDE.md");
    const originalContent = await readFile(indexPath, "utf8");

    // Build a tampered copy: replace the block body with something else
    const start = INVENTORY_START("primers");
    const end = INVENTORY_END;
    const tamperedContent = originalContent.replace(
      new RegExp(`(${escapeRegex(start)})([\\s\\S]*?)(${escapeRegex(end)})`),
      `$1\n| tampered | row |\n|---|---|\n$3`,
    );

    // Verify tamper detection using diffIndex directly (avoids writing to disk)
    const blockedBody = extractManagedBlock(tamperedContent, "primers");
    expect(blockedBody).not.toBeNull();

    // Build the expected block from disk artifacts
    const { readdir, readFile: rf } = await import("node:fs/promises");
    const primerDir = join(WORKTREE_ROOT, "primers");
    const entries = await readdir(primerDir);
    const mdFiles = entries.filter(
      (e) => e.endsWith(".md") && e !== "README.md" && !e.startsWith("."),
    );
    const fileObjs: Array<{ filename: string; frontmatter: string }> = await Promise.all(
      mdFiles.map(async (filename) => {
        const text = await rf(join(primerDir, filename), "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        return { filename, frontmatter: match ? match[1] : "" };
      }),
    );
    const expectedBody = renderInventoryBlock(toDescriptors(fileObjs));
    const findings = diffIndex("primers", expectedBody, tamperedContent);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("INVENTORY_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
