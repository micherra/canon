/**
 * Tests for worktree-settings.ts — settings injection utility
 *
 * Covers:
 * - profileToAllowRules: built-in tools pass through correctly
 * - profileToAllowRules: MCP tools are filtered out
 * - profileToAllowRules: empty input returns empty array
 * - profileToAllowRules: all-MCP input returns empty array
 * - buildWorktreeSettings: correct JSON structure
 * - buildWorktreeSettings: empty rules produce empty allow array
 * - injectWorktreeSettings: creates .claude dir and writes file (temp dir)
 * - injectWorktreeSettings: returns false on invalid path without throwing
 * - injectWorktreeSettings: file contents match expected JSON for a known profile
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildWorktreeSettings,
  injectWorktreeSettings,
  profileToAllowRules,
} from "../services/worktree-settings.ts";

// ---------------------------------------------------------------------------
// profileToAllowRules
// ---------------------------------------------------------------------------

describe("profileToAllowRules", () => {
  it("returns correct rules for implementor profile (Read, Write, Edit, Bash, Glob, Grep, NotebookEdit)", () => {
    const implementorTools = [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "write_implementation_summary",
      "post_message",
      "get_messages",
      "graph_query",
    ];
    const rules = profileToAllowRules(implementorTools);
    expect(rules).toContain("Read");
    expect(rules).toContain("Grep");
    expect(rules).toContain("Glob");
    expect(rules).toContain("Bash");
    expect(rules).toContain("Edit");
    expect(rules).toContain("Write");
    expect(rules).toContain("NotebookEdit");
    // 7 built-in tools from implementor profile
    expect(rules).toHaveLength(7);
  });

  it("filters out MCP tools (graph_query, semantic_search, etc.)", () => {
    const mixedTools = [
      "Read",
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
      "write_plan_index",
      "write_implementation_summary",
      "post_message",
      "get_messages",
    ];
    const rules = profileToAllowRules(mixedTools);
    expect(rules).toEqual(["Read"]);
    expect(rules).not.toContain("graph_query");
    expect(rules).not.toContain("semantic_search");
    expect(rules).not.toContain("get_file_context");
    expect(rules).not.toContain("codebase_graph");
    expect(rules).not.toContain("write_plan_index");
    expect(rules).not.toContain("write_implementation_summary");
    expect(rules).not.toContain("post_message");
    expect(rules).not.toContain("get_messages");
  });

  it("returns empty array for empty input", () => {
    expect(profileToAllowRules([])).toEqual([]);
  });

  it("returns empty array when all tools are MCP tools", () => {
    const mcpOnlyTools = [
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
      "write_plan_index",
      "write_research_synthesis",
      "review_code",
      "write_review",
    ];
    expect(profileToAllowRules(mcpOnlyTools)).toEqual([]);
  });

  it("includes WebFetch as a built-in tool (researcher profile)", () => {
    const researcherTools = [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "WebFetch",
      "graph_query",
      "get_file_context",
      "semantic_search",
      "codebase_graph",
      "write_research_synthesis",
    ];
    const rules = profileToAllowRules(researcherTools);
    expect(rules).toContain("WebFetch");
    expect(rules).toContain("Read");
    expect(rules).toContain("Grep");
    expect(rules).toContain("Glob");
    expect(rules).toContain("Bash");
    expect(rules).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// buildWorktreeSettings
// ---------------------------------------------------------------------------

describe("buildWorktreeSettings", () => {
  it("produces correct JSON structure with allow rules", () => {
    const settings = buildWorktreeSettings(["Bash", "Edit", "Read"]);
    expect(settings).toEqual({
      permissions: {
        allow: ["Bash", "Edit", "Read"],
      },
    });
  });

  it("with empty rules produces empty allow array (fail-closed)", () => {
    const settings = buildWorktreeSettings([]);
    expect(settings).toEqual({
      permissions: {
        allow: [],
      },
    });
  });

  it("preserves the exact order of allow rules", () => {
    const rules = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
    const settings = buildWorktreeSettings(rules);
    expect(settings.permissions.allow).toEqual(rules);
  });
});

// ---------------------------------------------------------------------------
// injectWorktreeSettings — filesystem tests
// ---------------------------------------------------------------------------

describe("injectWorktreeSettings", () => {
  it("creates .claude directory and writes settings file in temp dir", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "worktree-settings-test-"));
    const tools = ["Read", "Write", "Edit", "Bash"];

    const result = await injectWorktreeSettings(tempDir, tools);

    expect(result).toBe(true);

    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const content = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({
      permissions: {
        allow: ["Read", "Write", "Edit", "Bash"],
      },
    });
  });

  it("returns false on invalid (relative) path without throwing", async () => {
    const result = await injectWorktreeSettings("relative/path", ["Read"]);
    expect(result).toBe(false);
  });

  it("returns false on empty path without throwing", async () => {
    const result = await injectWorktreeSettings("", ["Read"]);
    expect(result).toBe(false);
  });

  it("file contents match expected JSON for a known profile (implementor)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "worktree-settings-test-"));
    const implementorTools = [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "write_implementation_summary",
      "post_message",
      "get_messages",
      "graph_query",
    ];

    const result = await injectWorktreeSettings(tempDir, implementorTools);
    expect(result).toBe(true);

    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const content = await readFile(settingsPath, "utf8");

    // Verify it's valid JSON with 2-space indent
    expect(content).toMatch(/^\{/);
    const parsed = JSON.parse(content);

    // Built-in tools only — MCP tools excluded
    expect(parsed.permissions.allow).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
  });

  it("is idempotent — can write settings to the same worktree twice", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "worktree-settings-test-"));

    const result1 = await injectWorktreeSettings(tempDir, ["Read", "Bash"]);
    expect(result1).toBe(true);

    const result2 = await injectWorktreeSettings(tempDir, ["Read"]);
    expect(result2).toBe(true);

    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const content = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(content);
    // Second write wins
    expect(parsed.permissions.allow).toEqual(["Read"]);
  });

  it("returns false for non-existent path that cannot be created (e.g., path under a file)", async () => {
    // Writing into a path that is under a regular file (not a directory)
    // will fail. Use /dev/null/ which is not a valid directory on macOS.
    const result = await injectWorktreeSettings("/dev/null/invalid", ["Read"]);
    expect(result).toBe(false);
  });
});
