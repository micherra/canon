/**
 * Tests for tool-profiles.ts — agent tool profile registry and resolver
 */

import { describe, expect, it } from "vitest";
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

  it("permission mode defaults to prompt when isolation=worktree but no worktreePath", () => {
    const result = resolveToolProfile("canon-implementor", undefined, "worktree", undefined);
    expect(result.permission_mode).toBe("prompt");
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
});
