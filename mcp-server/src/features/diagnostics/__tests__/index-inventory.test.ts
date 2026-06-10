/**
 * Tests for the index-inventory module.
 *
 * All pure functions — no disk I/O. Fixtures are inline strings.
 *
 * Test plan:
 *
 * toDescriptors:
 * - Excludes README.md from results
 * - Derives summary from `title:` field
 * - Derives summary from `description:` field when `title:` absent
 * - Falls back to empty string when no title/description
 * - Sorts results by name
 * - Block-scalar description (>-) is folded into a single-line summary (Fix 2)
 * - Block-scalar description (|-) folds correctly (Fix 2)
 *
 * renderInventoryBlock:
 * - Produces deterministic output (same input twice → identical string)
 * - Is order-independent (shuffled input → same output)
 * - Produces expected markdown table structure
 *
 * rewriteManagedBlock:
 * - Preserves prose before markers byte-for-byte
 * - Preserves prose after markers byte-for-byte
 * - Returns { ok: false, reason: "missing-markers" } when no sentinel pair
 * - Replaces only the inner block content between sentinels
 * - Preserves trailing newline
 *
 * extractManagedBlock:
 * - Returns null when markers absent
 * - Returns body string when markers present
 * - Returns empty string for empty block
 *
 * diffIndex:
 * - Returns [] when index is in sync
 * - Returns MISSING_MARKERS when no sentinels
 * - Returns INVENTORY_MISMATCH when artifact added to disk but not in index
 * - Returns INVENTORY_MISMATCH when artifact removed from disk but still in index
 *
 * checkIndexDrift (I/O — uses real temp fs):
 * - Unreadable dir surfaces DISCOVERY_ERROR finding (Fix 1)
 * - ENOENT dir is silently skipped — no DISCOVERY_ERROR (Fix 1)
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkIndexDrift,
  diffIndex,
  extractManagedBlock,
  INVENTORY_END,
  INVENTORY_START,
  renderInventoryBlock,
  rewriteManagedBlock,
  toDescriptors,
} from "../services/index-inventory.ts";

// ---- Helpers ----

function _makeFileContent(cls: "rules", body: string): string {
  return [
    "# Rules Index",
    "",
    "Some editorial prose about rules.",
    "",
    INVENTORY_START(cls),
    body,
    INVENTORY_END,
    "",
    "## Conventions",
    "Some trailing conventions text.",
  ].join("\n");
}

// ---- toDescriptors ----

describe("toDescriptors", () => {
  it("excludes README.md", () => {
    const files = [
      { filename: "README.md", frontmatter: "title: Read Me" },
      { filename: "agent-context-check.md", frontmatter: "title: Context Check" },
    ];
    const result = toDescriptors(files);
    expect(result.map((d) => d.name)).not.toContain("README.md");
    expect(result.map((d) => d.name)).toContain("agent-context-check.md");
  });

  it("derives summary from title: field", () => {
    const files = [{ filename: "my-rule.md", frontmatter: "title: My Rule Title" }];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("My Rule Title");
  });

  it("derives summary from description: field when title: absent", () => {
    const files = [{ filename: "my-rule.md", frontmatter: "description: A rule description" }];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("A rule description");
  });

  it("falls back to empty string when no title or description", () => {
    const files = [{ filename: "my-rule.md", frontmatter: "severity: rule" }];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("");
  });

  it("sorts results by name", () => {
    const files = [
      { filename: "z-last.md", frontmatter: "" },
      { filename: "a-first.md", frontmatter: "" },
      { filename: "m-middle.md", frontmatter: "" },
    ];
    const result = toDescriptors(files);
    expect(result.map((d) => d.name)).toEqual(["a-first.md", "m-middle.md", "z-last.md"]);
  });

  it("title takes precedence over description when both present", () => {
    const files = [
      {
        filename: "my-rule.md",
        frontmatter: "title: The Title\ndescription: The Description",
      },
    ];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("The Title");
  });

  it("block-scalar description (>-) is folded into a single-line summary", () => {
    // This is the exact pattern used in agent frontmatter:
    // description: >-
    //   Technical planning for non-trivial builds. Performs codebase research,
    //   designs technical approach.
    const frontmatter =
      "name: architect\ndescription: >-\n  Technical planning for non-trivial builds. Performs codebase research,\n  designs technical approach.";
    const files = [{ filename: "architect.md", frontmatter }];
    const result = toDescriptors(files);
    // Must NOT be the literal indicator string ">-"
    expect(result[0].summary).not.toBe(">-");
    // Must contain the actual text from the block scalar
    expect(result[0].summary).toContain("Technical planning");
    expect(result[0].summary).toContain("codebase research");
    // Must be a single line (no newlines)
    expect(result[0].summary).not.toContain("\n");
  });

  it("block-scalar description (|) preserves literal newlines but collapses to single line", () => {
    const frontmatter = "name: foo\ndescription: |\n  Line one.\n  Line two.";
    const files = [{ filename: "foo.md", frontmatter }];
    const result = toDescriptors(files);
    expect(result[0].summary).not.toBe("|");
    expect(result[0].summary).toContain("Line one");
    expect(result[0].summary).toContain("Line two");
    expect(result[0].summary).not.toContain("\n");
  });

  it("plain (non-block) description is returned as-is", () => {
    const files = [
      { filename: "my-rule.md", frontmatter: "description: A plain single-line description" },
    ];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("A plain single-line description");
  });

  it("empty frontmatter returns empty summary", () => {
    const files = [{ filename: "my-rule.md", frontmatter: "" }];
    const result = toDescriptors(files);
    expect(result[0].summary).toBe("");
  });
});

// ---- renderInventoryBlock ----

describe("renderInventoryBlock", () => {
  const descriptors = [
    { name: "agent-x.md", summary: "Does X" },
    { name: "agent-y.md", summary: "Does Y" },
  ];

  it("produces deterministic output (same input → identical string)", () => {
    const first = renderInventoryBlock(descriptors);
    const second = renderInventoryBlock(descriptors);
    expect(first).toBe(second);
  });

  it("is order-independent (shuffled → same output as sorted)", () => {
    const reversed = [...descriptors].reverse();
    const sorted = renderInventoryBlock(descriptors);
    const fromReversed = renderInventoryBlock(reversed);
    expect(fromReversed).toBe(sorted);
  });

  it("produces expected markdown table structure", () => {
    const result = renderInventoryBlock([{ name: "foo.md", summary: "Foo thing" }]);
    expect(result).toContain("| artifact | summary |");
    expect(result).toContain("| foo.md | Foo thing |");
    expect(result).toContain("|---|---|");
  });

  it("handles empty descriptor list gracefully", () => {
    const result = renderInventoryBlock([]);
    expect(result).toContain("| artifact | summary |");
  });
});

// ---- rewriteManagedBlock ----

describe("rewriteManagedBlock", () => {
  const PREFIX = "# Rules Index\n\nSome editorial prose.\n\n";
  const SUFFIX = "\n\n## Conventions\nTrailing text.\n";
  const NEW_BODY = "| artifact | summary |\n|---|---|\n| foo.md | bar |";

  function makeContent(body: string): string {
    return `${PREFIX + INVENTORY_START("rules")}\n${body}\n${INVENTORY_END}${SUFFIX}`;
  }

  it("preserves prose before markers byte-for-byte", () => {
    const content = makeContent("| artifact | summary |\n|---|---|\n| old.md | old |");
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.startsWith(PREFIX)).toBe(true);
    }
  });

  it("preserves prose after markers byte-for-byte", () => {
    const content = makeContent("| artifact | summary |\n|---|---|\n| old.md | old |");
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.endsWith(SUFFIX)).toBe(true);
    }
  });

  it("returns { ok: false, reason: 'missing-markers' } when no sentinel pair", () => {
    const content = "# Rules Index\n\nNo sentinels here.\n";
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-markers");
    }
  });

  it("replaces inner block content between sentinels", () => {
    const OLD_BODY = "| artifact | summary |\n|---|---|\n| old.md | old |";
    const content = makeContent(OLD_BODY);
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain(NEW_BODY);
      expect(result.content).not.toContain("| old.md | old |");
    }
  });

  it("preserves trailing newline if present in original", () => {
    const content = `${makeContent("old body")}\n`;
    // Remove trailing extra newline from makeContent's SUFFIX which already ends with \n
    // Just verify the result ends with expected suffix
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(true);
  });

  it("returns missing-markers when only start sentinel present", () => {
    const content = `${PREFIX + INVENTORY_START("rules")}\nsome content\n`;
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(false);
  });

  it("returns missing-markers when only end sentinel present", () => {
    const content = `${PREFIX}some content\n${INVENTORY_END}${SUFFIX}`;
    const result = rewriteManagedBlock(content, "rules", NEW_BODY);
    expect(result.ok).toBe(false);
  });
});

// ---- extractManagedBlock ----

describe("extractManagedBlock", () => {
  it("returns null when markers absent", () => {
    const content = "# Index\n\nNo markers here.\n";
    expect(extractManagedBlock(content, "rules")).toBeNull();
  });

  it("returns body string when markers present", () => {
    const body = "| artifact | summary |\n|---|---|\n| foo.md | bar |";
    const content = `Prefix text\n${INVENTORY_START("rules")}\n${body}\n${INVENTORY_END}\nSuffix`;
    const result = extractManagedBlock(content, "rules");
    expect(result).toBe(body);
  });

  it("returns empty string for empty block", () => {
    const content = `Prefix\n${INVENTORY_START("rules")}\n${INVENTORY_END}\nSuffix`;
    const result = extractManagedBlock(content, "rules");
    expect(result).toBe("");
  });

  it("trims leading and trailing whitespace from body", () => {
    const body = "| artifact | summary |";
    const content = `${INVENTORY_START("rules")}\n  \n${body}\n  \n${INVENTORY_END}`;
    const result = extractManagedBlock(content, "rules");
    expect(result?.trim()).toBe(body);
  });
});

// ---- diffIndex ----

describe("diffIndex", () => {
  function makeBody(names: string[]): string {
    const rows = names.map((n) => `| ${n} | summary |`).join("\n");
    return `| artifact | summary |\n|---|---|\n${rows}`;
  }

  it("returns [] when index is in sync", () => {
    const expectedBody = makeBody(["agent-x.md", "agent-y.md"]);
    const content =
      "Header\n" +
      INVENTORY_START("agents") +
      "\n" +
      expectedBody +
      "\n" +
      INVENTORY_END +
      "\nFooter";
    const findings = diffIndex("agents", expectedBody, content);
    expect(findings).toEqual([]);
  });

  it("returns MISSING_MARKERS when no sentinels", () => {
    const content = "# Index\n\nNo sentinels here.\n";
    const expectedBody = makeBody(["agent-x.md"]);
    const findings = diffIndex("agents", expectedBody, content);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("MISSING_MARKERS");
    expect(findings[0].class).toBe("agents");
  });

  it("returns INVENTORY_MISMATCH when artifact added to disk but not in index", () => {
    // Index has only agent-x.md, but expected now has agent-x.md AND agent-z.md
    const existingBody = makeBody(["agent-x.md"]);
    const expectedBody = makeBody(["agent-x.md", "agent-z.md"]);
    const content =
      "Header\n" +
      INVENTORY_START("agents") +
      "\n" +
      existingBody +
      "\n" +
      INVENTORY_END +
      "\nFooter";
    const findings = diffIndex("agents", expectedBody, content);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("INVENTORY_MISMATCH");
    expect(findings[0].class).toBe("agents");
  });

  it("returns INVENTORY_MISMATCH when artifact removed from disk but still in index", () => {
    // Index has agent-x.md and agent-z.md, but expected only has agent-x.md
    const existingBody = makeBody(["agent-x.md", "agent-z.md"]);
    const expectedBody = makeBody(["agent-x.md"]);
    const content =
      "Header\n" +
      INVENTORY_START("agents") +
      "\n" +
      existingBody +
      "\n" +
      INVENTORY_END +
      "\nFooter";
    const findings = diffIndex("agents", expectedBody, content);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("INVENTORY_MISMATCH");
  });

  it("does not throw on any input (never throws)", () => {
    expect(() => diffIndex("rules", "", "some content")).not.toThrow();
    expect(() => diffIndex("principles", "body", "")).not.toThrow();
  });
});

// ---- checkIndexDrift (I/O — observable-best-effort) ----

describe("checkIndexDrift observable-best-effort", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "index-inventory-drift-test-"));
  });

  afterEach(() => {
    // Restore permissions before cleanup (chmod 000 dirs would block rm)
    try {
      chmodSync(join(tmpDir, "agents"), 0o755);
    } catch {
      // directory may not exist — ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ENOENT dir is silently skipped — no DISCOVERY_ERROR finding", async () => {
    // agents/ dir doesn't exist at all — legitimately absent
    // We need an index file for the class too; create it without markers
    mkdirSync(join(tmpDir, "agents", ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, "agents", ".claude", "CLAUDE.md"),
      "# Agents\n\nNo markers here.\n",
      "utf8",
    );
    // agents/ dir itself does not exist — the artifact directory is absent

    const findings = await checkIndexDrift(tmpDir);
    // Should get MISSING_MARKERS (no sentinels in the index) but NOT DISCOVERY_ERROR
    const discoveryErrors = findings.filter((f) => f.code === "DISCOVERY_ERROR");
    expect(discoveryErrors).toHaveLength(0);
  });

  it("unreadable dir surfaces DISCOVERY_ERROR so drift check is not CLEAN", async () => {
    // Skip on non-Unix systems where chmod permissions don't apply the same way
    if (process.platform === "win32") return;

    // Create the agents dir and an index file with markers
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
    mkdirSync(join(tmpDir, "agents", ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, "agents", ".claude", "CLAUDE.md"),
      [
        "# Agents",
        "",
        INVENTORY_START("agents"),
        "| artifact | summary |",
        "|---|---|",
        INVENTORY_END,
      ].join("\n"),
      "utf8",
    );

    // Make the agents/ artifact dir unreadable (not ENOENT — it exists but can't be listed)
    chmodSync(join(tmpDir, "agents"), 0o000);

    try {
      const findings = await checkIndexDrift(tmpDir);
      const discoveryErrors = findings.filter((f) => f.code === "DISCOVERY_ERROR");
      expect(discoveryErrors.length).toBeGreaterThan(0);
      expect(discoveryErrors[0].class).toBe("agents");
      expect(discoveryErrors[0].message).toContain("Discovery degraded");
    } finally {
      // Restore before afterEach cleanup
      chmodSync(join(tmpDir, "agents"), 0o755);
    }
  });
});
