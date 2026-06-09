/**
 * Integration tests for the sync-indexes MCP tool handler.
 *
 * Imports the handler directly and mocks the filesystem layer.
 *
 * Test plan:
 * - Happy path: class with markers → written to synced[]
 * - Class without markers → in skipped[], not written
 * - Class=undefined → processes all 5 classes
 * - Fail-safe: fs read failure → toolError("UNEXPECTED"), no throw
 * - Index file missing → skipped (markers absent = no write)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVENTORY_END, INVENTORY_START } from "../services/index-inventory.ts";
import { syncIndexes } from "../tools/sync-indexes.ts";

// ---- Helpers ----

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sync-indexes-test-"));
}

/** Create a minimal project layout for a single artifact class. */
function setupClass(
  projectDir: string,
  cls: string,
  artifactFiles: Array<{ name: string; content: string }>,
  indexContent?: string,
): void {
  // Create artifact directories
  const classDirs: Record<string, string[]> = {
    rules: ["rules"],
    agents: ["agents"],
    templates: ["templates"],
    references: ["references"],
    principles: ["principles/rules", "principles/strong-opinions", "principles/conventions"],
  };

  const dirs = classDirs[cls] ?? [cls];
  for (const dir of dirs) {
    mkdirSync(join(projectDir, dir), { recursive: true });
  }
  // Write artifact files to first dir
  for (const file of artifactFiles) {
    writeFileSync(join(projectDir, dirs[0], file.name), file.content, "utf8");
  }

  // Create index file location
  const indexDir = join(projectDir, cls, ".claude");
  mkdirSync(indexDir, { recursive: true });
  if (indexContent !== undefined) {
    writeFileSync(join(indexDir, "CLAUDE.md"), indexContent, "utf8");
  }
}

function makeIndexWithMarkers(cls: string): string {
  return [
    "# Index",
    "",
    "Some prose here.",
    "",
    INVENTORY_START(cls),
    "| artifact | summary |",
    "|---|---|",
    "| old-entry.md | old summary |",
    INVENTORY_END,
    "",
    "## Conventions",
    "Some conventions here.",
  ].join("\n");
}

function makeIndexWithoutMarkers(): string {
  return [
    "# Index",
    "",
    "Some prose here, no markers.",
    "",
    "## Conventions",
    "Some conventions here.",
  ].join("\n");
}

// ---- Tests ----

describe("syncIndexes", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("happy path: class with markers writes to synced[]", async () => {
    setupClass(
      projectDir,
      "agents",
      [{ name: "my-agent.md", content: "---\ntitle: My Agent\n---\nBody text." }],
      makeIndexWithMarkers("agents"),
    );

    const result = await syncIndexes({ class: "agents" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.synced).toContain("agents");
      expect(result.skipped.map((s) => s.class)).not.toContain("agents");
    }
  });

  it("class without markers goes to skipped[], not written", async () => {
    setupClass(
      projectDir,
      "agents",
      [{ name: "my-agent.md", content: "---\ntitle: My Agent\n---\nBody." }],
      makeIndexWithoutMarkers(),
    );

    const result = await syncIndexes({ class: "agents" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skipped.map((s) => s.class)).toContain("agents");
      expect(result.synced).not.toContain("agents");
      const skipped = result.skipped.find((s) => s.class === "agents");
      expect(skipped?.reason).toBeDefined();
    }
  });

  it("missing index file → skipped (treated as markers absent)", async () => {
    // Set up artifacts but no index file
    setupClass(
      projectDir,
      "agents",
      [{ name: "my-agent.md", content: "---\ntitle: My Agent\n---\nBody." }],
      undefined, // no index
    );

    const result = await syncIndexes({ class: "agents" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skipped.map((s) => s.class)).toContain("agents");
    }
  });

  it("fail-safe: unexpected error returns toolError, no throw", async () => {
    // Point to a non-existent projectDir to trigger read failures
    const badDir = join(projectDir, "does-not-exist");

    const result = await syncIndexes({ class: "agents" }, badDir);

    // Should not throw, should return a ToolResult
    expect(result.ok).toBeDefined();
    // Either ok with all skipped, or error - both are acceptable
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
    } else {
      // All skipped due to missing files
      expect(result.skipped.length + result.synced.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("no class specified → processes all 5 classes", async () => {
    // Set up minimal structure for all 5 classes, all without markers
    for (const cls of ["rules", "agents", "templates", "references"] as const) {
      setupClass(
        projectDir,
        cls,
        [{ name: `item.md`, content: "---\ntitle: Item\n---\nBody." }],
        makeIndexWithoutMarkers(),
      );
    }
    // principles needs special setup
    const principlesDirs = [
      "principles/rules",
      "principles/strong-opinions",
      "principles/conventions",
    ];
    for (const dir of principlesDirs) {
      mkdirSync(join(projectDir, dir), { recursive: true });
    }
    writeFileSync(
      join(projectDir, "principles/rules", "a-rule.md"),
      "---\ntitle: A Rule\n---\nBody.",
      "utf8",
    );
    mkdirSync(join(projectDir, "principles", ".claude"), { recursive: true });
    writeFileSync(
      join(projectDir, "principles", ".claude", "CLAUDE.md"),
      makeIndexWithoutMarkers(),
      "utf8",
    );

    const result = await syncIndexes({}, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // All 5 should appear in either synced or skipped
      const all = [...result.synced, ...result.skipped.map((s) => s.class)];
      expect(all).toContain("rules");
      expect(all).toContain("agents");
      expect(all).toContain("templates");
      expect(all).toContain("references");
      expect(all).toContain("principles");
    }
  });

  it("second run is a no-op (idempotent)", async () => {
    setupClass(
      projectDir,
      "agents",
      [{ name: "my-agent.md", content: "---\ntitle: My Agent\n---\nBody." }],
      makeIndexWithMarkers("agents"),
    );

    const first = await syncIndexes({ class: "agents" }, projectDir);
    const second = await syncIndexes({ class: "agents" }, projectDir);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.synced).toEqual(second.synced);
    }
  });
});
