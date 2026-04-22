import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAgentSkills,
  type ResolveAgentSkillsResult,
} from "@features/orchestration/tools/resolve-agent-skills.ts";
import { assertOk } from "@shared/lib/tool-result.ts";

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-skills-resolver-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  return pluginDir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(
    join(pluginDir, "agents", `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}`,
  );
}

function writeSkill(pluginDir: string, kind: "rules" | "references" | "primers", id: string, body: string) {
  writeFileSync(join(pluginDir, kind, `${id}.md`), body);
}

function ok(
  result: ReturnType<typeof resolveAgentSkills>,
): { ok: true } & ResolveAgentSkillsResult {
  assertOk<ResolveAgentSkillsResult>(result);
  return result;
}

describe("resolveAgentSkills", () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = seedPluginDir();
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  it("resolves rule:<name> to rules/<name>.md", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "TDD rule body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - rule:agent-tdd-required"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].kind).toBe("rule");
    expect(out.skills[0].content).toContain("TDD rule body");
    expect(out.unresolved).toHaveLength(0);
  });

  it("resolves ref:<name> to references/<name>.md", () => {
    writeSkill(pluginDir, "references", "status-protocol", "Status protocol ref body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - ref:status-protocol"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("ref");
    expect(out.skills[0].content).toContain("Status protocol ref body");
  });

  it("resolves primer:<name> to primers/<name>.md", () => {
    writeSkill(pluginDir, "primers", "backend-api", "API primer body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - primer:backend-api"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("primer");
    expect(out.skills[0].content).toContain("API primer body");
  });

  it("resolves bare names by searching rules/, references/, primers/ in order", () => {
    writeSkill(pluginDir, "references", "status-protocol", "status body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - status-protocol"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].kind).toBe("ref");
    expect(out.unresolved).toHaveLength(0);
  });

  it("prefers rules/ when a bare name exists in multiple locations", () => {
    writeSkill(pluginDir, "rules", "ambiguous", "rules version\n");
    writeSkill(pluginDir, "references", "ambiguous", "references version\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - ambiguous"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("rule");
    expect(out.skills[0].content).toContain("rules version");
  });

  it("returns unresolved for unknown prefixes", () => {
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - flavor:blueberry"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["flavor:blueberry"]);
  });

  it("returns unresolved for missing skill files", () => {
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - rule:does-not-exist"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["rule:does-not-exist"]);
  });

  it("handles agents with no skills frontmatter", () => {
    writeAgent(pluginDir, "engineer", "name: engineer");
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
    expect(out.preload_prompt).toBe("");
  });

  it("strips canon: prefix from agent_name", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "skills:", "  - rule:agent-tdd-required"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "canon:engineer" }, pluginDir));
    expect(out.agent_name).toBe("engineer");
    expect(out.skills).toHaveLength(1);
  });

  it("produces a preload_prompt with section headers and separators", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "TDD rule body");
    writeSkill(pluginDir, "references", "status-protocol", "Status protocol ref body");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "skills:",
        "  - rule:agent-tdd-required",
        "  - ref:status-protocol",
      ].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.preload_prompt).toContain("## Preloaded Skills");
    expect(out.preload_prompt).toContain("### Rule: rule:agent-tdd-required");
    expect(out.preload_prompt).toContain("### Reference: ref:status-protocol");
    expect(out.preload_prompt).toContain("TDD rule body");
    expect(out.preload_prompt).toContain("Status protocol ref body");
    expect(out.preload_prompt).toContain("---");
  });

  it("preserves skill order from the frontmatter list", () => {
    writeSkill(pluginDir, "rules", "first", "first body");
    writeSkill(pluginDir, "rules", "second", "second body");
    writeSkill(pluginDir, "rules", "third", "third body");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "skills:",
        "  - rule:second",
        "  - rule:third",
        "  - rule:first",
      ].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.id)).toEqual([
      "rule:second",
      "rule:third",
      "rule:first",
    ]);
  });

  it("returns INVALID_INPUT when agent file is missing", () => {
    const result = resolveAgentSkills({ agent_name: "nonexistent" }, pluginDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("Agent file not found");
    }
  });

  it("returns INVALID_INPUT for agent_name with invalid characters", () => {
    const result = resolveAgentSkills({ agent_name: "../etc/passwd" }, pluginDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("skips non-string entries in skills list", () => {
    writeSkill(pluginDir, "rules", "valid-rule", "valid body");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "skills:",
        "  - rule:valid-rule",
        "  - 42",
        "  - {nested: object}",
      ].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].id).toBe("rule:valid-rule");
  });
});
