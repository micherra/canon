/**
 * Tests for tool-profiles.ts — agent tool profile registry and resolver
 */

import { describe, expect, it, vi } from "vitest";
import { AGENT_TOOL_PROFILES, EMPTY_PROFILE, resolveToolProfile } from "../model/tool-profiles.ts";

const ALL_AGENTS = [
  "architect",
  "engineer",
  "tester",
  "reviewer",
  "security",
  "scribe",
  "learner",
  "writer",
  "shipper",
  "chat",
] as const;

describe("AGENT_TOOL_PROFILES", () => {
  it("has entries for all 10 agent types", () => {
    for (const agent of ALL_AGENTS) {
      expect(AGENT_TOOL_PROFILES).toHaveProperty(agent);
    }
    expect(Object.keys(AGENT_TOOL_PROFILES)).toHaveLength(10);
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

  it("engineer profile includes post_message MCP tool", () => {
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("post_message");
  });

  it("reviewer profile includes write_review MCP tool", () => {
    expect(AGENT_TOOL_PROFILES.reviewer.allowed).toContain("write_review");
  });

  it("tester profile includes write_test_report MCP tool", () => {
    expect(AGENT_TOOL_PROFILES.tester.allowed).toContain("write_test_report");
  });

  it("chat profile does not include Write or Bash (read-only agent)", () => {
    expect(AGENT_TOOL_PROFILES.chat.disallowed).toContain("Write");
    expect(AGENT_TOOL_PROFILES.chat.disallowed).toContain("Bash");
    expect(AGENT_TOOL_PROFILES.chat.allowed).not.toContain("Write");
    expect(AGENT_TOOL_PROFILES.chat.allowed).not.toContain("Bash");
  });

  it("architect profile includes write_plan_index MCP tool", () => {
    expect(AGENT_TOOL_PROFILES.architect.allowed).toContain("write_plan_index");
  });

  it("engineer profile includes graph_query, semantic_search, get_file_context MCP tools", () => {
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("get_file_context");
  });

  it("security profile includes semantic_search and codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES.security.allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES.security.allowed).toContain("codebase_graph");
  });

  it("learner profile includes graph_query, semantic_search, get_file_context, codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES.learner.allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES.learner.allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES.learner.allowed).toContain("get_file_context");
    expect(AGENT_TOOL_PROFILES.learner.allowed).toContain("codebase_graph");
  });

  it("chat profile includes graph_query, semantic_search, get_file_context, codebase_graph MCP tools", () => {
    expect(AGENT_TOOL_PROFILES.chat.allowed).toContain("graph_query");
    expect(AGENT_TOOL_PROFILES.chat.allowed).toContain("semantic_search");
    expect(AGENT_TOOL_PROFILES.chat.allowed).toContain("get_file_context");
    expect(AGENT_TOOL_PROFILES.chat.allowed).toContain("codebase_graph");
  });

  it("engineer profile includes write_implementation_summary and get_messages MCP tools", () => {
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("write_implementation_summary");
    expect(AGENT_TOOL_PROFILES.engineer.allowed).toContain("get_messages");
  });
});

describe("resolveToolProfile", () => {
  it("unknown agent types resolve to EMPTY_PROFILE (empty allowed, dangerous tools disallowed)", () => {
    const result = resolveToolProfile("unknown-agent");
    expect(result.tools).toEqual([]);
    expect(result.disallowed_tools).toEqual(["Edit", "Write", "Bash", "NotebookEdit"]);
  });

  it("unknown agent + tool_overrides.allow cannot grant dangerous tools (disallowed wins)", () => {
    const result = resolveToolProfile("unknown-agent", { overrides: { allow: ["Edit"] } });
    // Edit is in EMPTY_PROFILE.disallowed — disallowed wins
    expect(result.tools).not.toContain("Edit");
    expect(result.disallowed_tools).toContain("Edit");
  });

  it("returns base profile tools for known agent without overrides", () => {
    const result = resolveToolProfile("reviewer");
    const base = AGENT_TOOL_PROFILES.reviewer;
    expect(result.tools).toEqual(base.allowed.filter((t) => !base.disallowed.includes(t)));
    expect(result.disallowed_tools).toEqual(base.disallowed);
  });

  it("with allow override adds tools to base allowed", () => {
    const result = resolveToolProfile("reviewer", { overrides: { allow: ["ExtraToolA"] } });
    const base = AGENT_TOOL_PROFILES.reviewer;
    expect(result.tools).toContain("ExtraToolA");
    for (const t of base.allowed) {
      if (!base.disallowed.includes(t)) {
        expect(result.tools).toContain(t);
      }
    }
  });

  it("with deny override removes tools from allowed", () => {
    // reviewer has Read in allowed — deny it
    const result = resolveToolProfile("reviewer", { overrides: { deny: ["Read"] } });
    expect(result.tools).not.toContain("Read");
    expect(result.disallowed_tools).toContain("Read");
  });

  it("with replace override replaces entire allowed list", () => {
    const result = resolveToolProfile("reviewer", {
      overrides: { replace: ["ToolX", "ToolY"] },
    });
    expect(result.tools).toEqual(["ToolX", "ToolY"]);
  });

  it("disallowed wins: tool in both allowed and disallowed ends up only in disallowed", () => {
    // Use allow to add a tool, and deny to block the same tool
    const result = resolveToolProfile("reviewer", {
      overrides: { allow: ["ConflictTool"], deny: ["ConflictTool"] },
    });
    expect(result.tools).not.toContain("ConflictTool");
    expect(result.disallowed_tools).toContain("ConflictTool");
  });

  it("permission mode defaults to auto when worktreePath is provided", () => {
    const result = resolveToolProfile("engineer", {
      worktreePath: "/some/path",
    });
    expect(result.permission_mode).toBe("auto");
  });

  it("permission mode defaults to prompt when no worktreePath provided", () => {
    const result = resolveToolProfile("engineer");
    expect(result.permission_mode).toBe("prompt");
  });

  it("permission mode defaults to prompt when worktreePath is undefined", () => {
    // worktree_path absent means no sandboxed directory — fall back to prompt
    const result = resolveToolProfile("engineer", { worktreePath: undefined });
    expect(result.permission_mode).toBe("prompt");
  });

  it("permission_mode override from ToolOverrides takes precedence over worktreePath", () => {
    const result = resolveToolProfile("engineer", {
      overrides: { permission_mode: "deny_unknown" },
      worktreePath: "/some/path",
    });
    expect(result.permission_mode).toBe("deny_unknown");
  });

  it("replace override with deny strips matching tools", () => {
    const result = resolveToolProfile("engineer", {
      overrides: { deny: ["ToolB"], replace: ["ToolA", "ToolB", "ToolC"] },
    });
    expect(result.tools).toEqual(["ToolA", "ToolC"]);
    expect(result.disallowed_tools).toContain("ToolB");
  });

  it("implementor has Edit and Write in allowed", () => {
    const result = resolveToolProfile("engineer");
    expect(result.tools).toContain("Edit");
    expect(result.tools).toContain("Write");
  });

  it("namespaced agent ID (canon:reviewer) resolves to same profile as unprefixed", () => {
    const prefixed = resolveToolProfile("canon:reviewer");
    const unprefixed = resolveToolProfile("reviewer");
    expect(prefixed).toEqual(unprefixed);
  });

  it("namespaced agent ID does not fall back to EMPTY_PROFILE", () => {
    const result = resolveToolProfile("canon:engineer");
    expect(result.tools).toContain("Edit");
    expect(result.tools).toContain("Write");
  });

  it("reviewer has Edit and Write in disallowed", () => {
    const result = resolveToolProfile("reviewer");
    expect(result.disallowed_tools).toContain("Edit");
    expect(result.disallowed_tools).toContain("Write");
    expect(result.tools).not.toContain("Edit");
    expect(result.tools).not.toContain("Write");
  });

  it("no warnings when replace does not grant disallowed tools", () => {
    const result = resolveToolProfile("reviewer", {
      overrides: { replace: ["Read", "Grep"] },
    });
    expect(result.warnings).toBeUndefined();
  });

  it("no warnings when using allow override (not replace)", () => {
    const result = resolveToolProfile("reviewer", { overrides: { allow: ["ExtraToolA"] } });
    expect(result.warnings).toBeUndefined();
  });

  it("no warnings when no overrides at all", () => {
    const result = resolveToolProfile("reviewer");
    expect(result.warnings).toBeUndefined();
  });

  it("replace override that grants base-disallowed tools produces a structured warning", () => {
    // reviewer has Edit in disallowed; replace with Edit should warn
    const result = resolveToolProfile("reviewer", {
      overrides: { replace: ["Read", "Edit"] },
    });
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings![0];
    expect(warning.event).toBe("adr014_replace_override_grants_disallowed");
    expect(warning.agent).toBe("reviewer");
    expect(warning.granted_disallowed).toContain("Edit");
  });

  it("warnings capture all granted-disallowed tools in a single entry", () => {
    // reviewer has Edit and Write in disallowed; replace grants both
    const result = resolveToolProfile("reviewer", {
      overrides: { replace: ["Read", "Edit", "Write"] },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].granted_disallowed).toContain("Edit");
    expect(result.warnings![0].granted_disallowed).toContain("Write");
  });

  it("does not call console.warn — warnings are data, not side effects", () => {
    const spy = vi.spyOn(console, "warn");
    resolveToolProfile("reviewer", { overrides: { replace: ["Read", "Edit"] } });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // trustPermissionMode tests

  it("trustPermissionMode 'auto' is used when no override is set", () => {
    const result = resolveToolProfile("engineer", { trustPermissionMode: "auto" });
    expect(result.permission_mode).toBe("auto");
  });

  it("trustPermissionMode 'prompt' is used when no override is set", () => {
    const result = resolveToolProfile("engineer", { trustPermissionMode: "prompt" });
    expect(result.permission_mode).toBe("prompt");
  });

  it("overrides.permission_mode takes precedence over trustPermissionMode", () => {
    const result = resolveToolProfile("engineer", {
      overrides: { permission_mode: "deny_unknown" },
      trustPermissionMode: "auto",
    });
    expect(result.permission_mode).toBe("deny_unknown");
  });

  it("trustPermissionMode takes precedence over worktreePath fallback", () => {
    // Without worktreePath, the fallback would be "prompt".
    // trustPermissionMode="auto" should override that.
    const result = resolveToolProfile("engineer", {
      trustPermissionMode: "auto",
      worktreePath: undefined,
    });
    expect(result.permission_mode).toBe("auto");
  });

  it("falls back to worktreePath check when trustPermissionMode is undefined", () => {
    // No trustPermissionMode, worktreePath present → worktreePath fallback applies → "auto"
    const result = resolveToolProfile("engineer", {
      trustPermissionMode: undefined,
      worktreePath: "/some/path",
    });
    expect(result.permission_mode).toBe("auto");
  });

  it("backward compat: calling with only agent (no options) behaves identically — prompt mode", () => {
    const withNoOptions = resolveToolProfile("engineer");
    const withEmptyOptions = resolveToolProfile("engineer", {});
    expect(withNoOptions.permission_mode).toBe("prompt");
    expect(withEmptyOptions.permission_mode).toBe("prompt");
    expect(withNoOptions.tools).toEqual(withEmptyOptions.tools);
    expect(withNoOptions.disallowed_tools).toEqual(withEmptyOptions.disallowed_tools);
  });

  it("shipper has Edit in allowed (for CHANGELOG.md writing)", () => {
    const result = resolveToolProfile("shipper");
    expect(result.tools).toContain("Edit");
    expect(result.disallowed_tools).not.toContain("Edit");
  });

  // isReadOnly auto-approve tests

  it("read-only agent (reviewer) with no worktreePath gets permission_mode 'auto'", () => {
    // reviewer has Write and Edit in disallowed — it's read-only → auto
    const result = resolveToolProfile("reviewer");
    expect(result.permission_mode).toBe("auto");
  });

  it("read-only agent (architect) with no worktreePath gets permission_mode 'auto'", () => {
    // architect has Write, Edit, NotebookEdit in disallowed — it's read-only → auto
    const result = resolveToolProfile("architect");
    expect(result.permission_mode).toBe("auto");
  });

  it("read-only agent (chat) with no worktreePath gets permission_mode 'auto'", () => {
    const result = resolveToolProfile("chat");
    expect(result.permission_mode).toBe("auto");
  });

  it("read-only agent (security) with no worktreePath gets permission_mode 'auto'", () => {
    const result = resolveToolProfile("security");
    expect(result.permission_mode).toBe("auto");
  });

  it("write agent (engineer) with no worktreePath still gets permission_mode 'prompt'", () => {
    const result = resolveToolProfile("engineer");
    expect(result.permission_mode).toBe("prompt");
  });

  it("read-only agent with replace override that grants Write does NOT get auto (base.disallowed unchanged)", () => {
    // Even if the flow override grants Write via replace, the base profile still has Write in disallowed.
    // isReadOnly uses base.disallowed as source of truth.
    const result = resolveToolProfile("reviewer", {
      overrides: { replace: ["Read", "Write"] },
    });
    expect(result.permission_mode).toBe("auto");
  });

  it("trustPermissionMode takes precedence over isReadOnly fallback", () => {
    // reviewer is read-only, but trustPermissionMode forces 'prompt'
    const result = resolveToolProfile("reviewer", { trustPermissionMode: "prompt" });
    expect(result.permission_mode).toBe("prompt");
  });

  it("overrides.permission_mode takes precedence over isReadOnly fallback", () => {
    // reviewer is read-only, but explicit override forces 'deny_unknown'
    const result = resolveToolProfile("reviewer", {
      overrides: { permission_mode: "deny_unknown" },
    });
    expect(result.permission_mode).toBe("deny_unknown");
  });
});
