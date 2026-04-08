/**
 * Tests for tool-profiles.ts — agent tool profile registry and resolver
 */

import { describe, expect, it, vi } from "vitest";
import { AGENT_TOOL_PROFILES, EMPTY_PROFILE, resolveToolProfile } from "../model/tool-profiles.ts";

const ALL_AGENTS = [
  "canon-researcher",
  "canon-architect",
  "canon-implementor",
  "canon-tester",
  "canon-reviewer",
  "canon-fixer",
  "canon-security",
  "canon-scribe",
  "canon-learner",
  "canon-guide",
  "canon-writer",
  "canon-shipper",
  "canon-chat",
] as const;

describe("AGENT_TOOL_PROFILES", () => {
  it("has entries for all 13 agent types", () => {
    for (const agent of ALL_AGENTS) {
      expect(AGENT_TOOL_PROFILES).toHaveProperty(agent);
    }
    expect(Object.keys(AGENT_TOOL_PROFILES)).toHaveLength(13);
  });

  it("each profile has at least one entry (allowed or disallowed)", () => {
    for (const agent of ALL_AGENTS) {
      const profile = AGENT_TOOL_PROFILES[agent];
      const hasEntries = profile.allowed.length > 0 || profile.disallowed.length > 0;
      expect(hasEntries, `${agent} profile should have at least one entry`).toBe(true);
    }
  });

  it("EMPTY_PROFILE has empty allowed array and denies dangerous tools", () => {
    expect(EMPTY_PROFILE.allowed).toEqual([]);
    expect(EMPTY_PROFILE.disallowed).toEqual(["Edit", "Write", "Bash", "NotebookEdit"]);
  });

  it("canon-researcher profile includes codebase_graph MCP tool", () => {
    expect(AGENT_TOOL_PROFILES["canon-researcher"].allowed).toContain("codebase_graph");
  });

  it("canon-implementor profile includes post_message MCP tool", () => {
    expect(AGENT_TOOL_PROFILES["canon-implementor"].allowed).toContain("post_message");
  });

  it("canon-reviewer profile includes write_review MCP tool", () => {
    expect(AGENT_TOOL_PROFILES["canon-reviewer"].allowed).toContain("write_review");
  });

  it("canon-tester profile includes write_test_report MCP tool", () => {
    expect(AGENT_TOOL_PROFILES["canon-tester"].allowed).toContain("write_test_report");
  });

  it("canon-chat profile does not include Write or Bash (read-only agent)", () => {
    expect(AGENT_TOOL_PROFILES["canon-chat"].disallowed).toContain("Write");
    expect(AGENT_TOOL_PROFILES["canon-chat"].disallowed).toContain("Bash");
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).not.toContain("Write");
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).not.toContain("Bash");
  });

  it("canon-architect profile includes write_plan_index and update_board MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-architect"].allowed).toContain("write_plan_index");
    expect(AGENT_TOOL_PROFILES["canon-architect"].allowed).toContain("update_board");
  });

  it("canon-fixer profile includes graph_query, semantic_search, get_file_context MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-fixer"].allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES["canon-fixer"].allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES["canon-fixer"].allowed).toContain("get_file_context");
  });

  it("canon-security profile includes semantic_search and codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-security"].allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES["canon-security"].allowed).toContain("codebase_graph");
  });

  it("canon-learner profile includes graph_query, semantic_search, get_file_context, codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-learner"].allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES["canon-learner"].allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES["canon-learner"].allowed).toContain("get_file_context");
    expect(AGENT_TOOL_PROFILES["canon-learner"].allowed).toContain("codebase_graph");
  });

  it("canon-guide profile includes graph_query, semantic_search, get_file_context, codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-guide"].allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES["canon-guide"].allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES["canon-guide"].allowed).toContain("get_file_context");
    expect(AGENT_TOOL_PROFILES["canon-guide"].allowed).toContain("codebase_graph");
  });

  it("canon-chat profile includes graph_query, semantic_search, get_file_context, codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).toContain("get_file_context");
    expect(AGENT_TOOL_PROFILES["canon-chat"].allowed).toContain("codebase_graph");
  });

  it("canon-implementor profile includes write_implementation_summary and get_messages MCP tools", () => {
    expect(AGENT_TOOL_PROFILES["canon-implementor"].allowed).toContain(
      "write_implementation_summary",
    );
    expect(AGENT_TOOL_PROFILES["canon-implementor"].allowed).toContain("get_messages");
  });
});

describe("resolveToolProfile", () => {
  it("unknown agent types resolve to EMPTY_PROFILE (empty allowed, dangerous tools disallowed)", () => {
    const result = resolveToolProfile("unknown-agent");
    expect(result.tools).toEqual([]);
    expect(result.disallowed_tools).toEqual(["Edit", "Write", "Bash", "NotebookEdit"]);
  });

  it("unknown agent + tool_overrides.allow cannot grant dangerous tools (disallowed wins)", () => {
    const result = resolveToolProfile("unknown-agent", { allow: ["Edit"] });
    // Edit is in EMPTY_PROFILE.disallowed — disallowed wins
    expect(result.tools).not.toContain("Edit");
    expect(result.disallowed_tools).toContain("Edit");
  });

  it("returns base profile tools for known agent without overrides", () => {
    const result = resolveToolProfile("canon-researcher");
    const base = AGENT_TOOL_PROFILES["canon-researcher"];
    expect(result.tools).toEqual(base.allowed.filter((t) => !base.disallowed.includes(t)));
    expect(result.disallowed_tools).toEqual(base.disallowed);
  });

  it("with allow override adds tools to base allowed", () => {
    const result = resolveToolProfile("canon-researcher", { allow: ["ExtraToolA"] });
    const base = AGENT_TOOL_PROFILES["canon-researcher"];
    expect(result.tools).toContain("ExtraToolA");
    for (const t of base.allowed) {
      if (!base.disallowed.includes(t)) {
        expect(result.tools).toContain(t);
      }
    }
  });

  it("with deny override removes tools from allowed", () => {
    // researcher has Read in allowed — deny it
    const result = resolveToolProfile("canon-researcher", { deny: ["Read"] });
    expect(result.tools).not.toContain("Read");
    expect(result.disallowed_tools).toContain("Read");
  });

  it("with replace override replaces entire allowed list", () => {
    const result = resolveToolProfile("canon-researcher", { replace: ["ToolX", "ToolY"] });
    expect(result.tools).toEqual(["ToolX", "ToolY"]);
  });

  it("disallowed wins: tool in both allowed and disallowed ends up only in disallowed", () => {
    // Use allow to add a tool, and deny to block the same tool
    const result = resolveToolProfile("canon-researcher", {
      allow: ["ConflictTool"],
      deny: ["ConflictTool"],
    });
    expect(result.tools).not.toContain("ConflictTool");
    expect(result.disallowed_tools).toContain("ConflictTool");
  });

  it("permission mode defaults to auto when isolation=worktree and worktreePath provided", () => {
    const result = resolveToolProfile("canon-implementor", undefined, "worktree", "/some/path");
    expect(result.permission_mode).toBe("auto");
  });

  it("permission mode defaults to prompt when no worktree isolation", () => {
    const result = resolveToolProfile("canon-implementor");
    expect(result.permission_mode).toBe("prompt");
  });

  it("permission mode defaults to auto when isolation=worktree even without worktreePath", () => {
    // worktree_path is not available at pipeline time (injected after assemblePrompt returns),
    // so isolation alone is the correct signal for auto mode.
    const result = resolveToolProfile("canon-implementor", undefined, "worktree", undefined);
    expect(result.permission_mode).toBe("auto");
  });

  it("permission_mode override from ToolOverrides takes precedence", () => {
    const result = resolveToolProfile(
      "canon-implementor",
      { permission_mode: "deny_unknown" },
      "worktree",
      "/some/path",
    );
    expect(result.permission_mode).toBe("deny_unknown");
  });

  it("replace override with deny strips matching tools", () => {
    const result = resolveToolProfile("canon-implementor", {
      deny: ["ToolB"],
      replace: ["ToolA", "ToolB", "ToolC"],
    });
    expect(result.tools).toEqual(["ToolA", "ToolC"]);
    expect(result.disallowed_tools).toContain("ToolB");
  });

  it("canon-implementor has Edit and Write in allowed", () => {
    const result = resolveToolProfile("canon-implementor");
    expect(result.tools).toContain("Edit");
    expect(result.tools).toContain("Write");
  });

  it("namespaced agent ID (canon:canon-researcher) resolves to same profile as unprefixed", () => {
    const prefixed = resolveToolProfile("canon:canon-researcher");
    const unprefixed = resolveToolProfile("canon-researcher");
    expect(prefixed).toEqual(unprefixed);
  });

  it("namespaced agent ID does not fall back to EMPTY_PROFILE", () => {
    const result = resolveToolProfile("canon:canon-implementor");
    expect(result.tools).toContain("Edit");
    expect(result.tools).toContain("Write");
  });

  it("canon-researcher has Edit and Write in disallowed", () => {
    const result = resolveToolProfile("canon-researcher");
    expect(result.disallowed_tools).toContain("Edit");
    expect(result.disallowed_tools).toContain("Write");
    expect(result.tools).not.toContain("Edit");
    expect(result.tools).not.toContain("Write");
  });

  it("no warnings when replace does not grant disallowed tools", () => {
    const result = resolveToolProfile("canon-researcher", { replace: ["Read", "Grep"] });
    expect(result.warnings).toBeUndefined();
  });

  it("no warnings when using allow override (not replace)", () => {
    const result = resolveToolProfile("canon-researcher", { allow: ["ExtraToolA"] });
    expect(result.warnings).toBeUndefined();
  });

  it("no warnings when no overrides at all", () => {
    const result = resolveToolProfile("canon-researcher");
    expect(result.warnings).toBeUndefined();
  });

  it("replace override that grants base-disallowed tools produces a structured warning", () => {
    // canon-researcher has Edit in disallowed; replace with Edit should warn
    const result = resolveToolProfile("canon-researcher", { replace: ["Read", "Edit"] });
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings![0];
    expect(warning.event).toBe("adr014_replace_override_grants_disallowed");
    expect(warning.agent).toBe("canon-researcher");
    expect(warning.granted_disallowed).toContain("Edit");
  });

  it("warnings capture all granted-disallowed tools in a single entry", () => {
    // canon-researcher has Edit and Write in disallowed; replace grants both
    const result = resolveToolProfile("canon-researcher", { replace: ["Read", "Edit", "Write"] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].granted_disallowed).toContain("Edit");
    expect(result.warnings![0].granted_disallowed).toContain("Write");
  });

  it("does not call console.warn — warnings are data, not side effects", () => {
    const spy = vi.spyOn(console, "warn");
    resolveToolProfile("canon-researcher", { replace: ["Read", "Edit"] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
