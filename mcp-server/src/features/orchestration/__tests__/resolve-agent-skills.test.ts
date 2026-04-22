import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ResolveAgentSkillsResult,
  resolveAgentSkills,
} from "@features/orchestration/tools/resolve-agent-skills.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-skills-resolver-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  return pluginDir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(join(pluginDir, "agents", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

function writeSkill(
  pluginDir: string,
  kind: "rules" | "references" | "primers",
  id: string,
  body: string,
) {
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
    rmSync(pluginDir, { force: true, recursive: true });
  });

  it("loads rules: entries from rules/<name>.md", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "TDD rule body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - agent-tdd-required"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].kind).toBe("rule");
    expect(out.skills[0].id).toBe("agent-tdd-required");
    expect(out.skills[0].content).toContain("TDD rule body");
    expect(out.unresolved).toHaveLength(0);
  });

  it("loads references: entries from references/<name>.md", () => {
    writeSkill(pluginDir, "references", "status-protocol", "Status protocol ref body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "references:", "  - status-protocol"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("ref");
    expect(out.skills[0].content).toContain("Status protocol ref body");
  });

  it("loads primers: entries from primers/<name>.md", () => {
    writeSkill(pluginDir, "primers", "backend-api", "API primer body\n");
    writeAgent(pluginDir, "engineer", ["name: engineer", "primers:", "  - backend-api"].join("\n"));
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("primer");
    expect(out.skills[0].content).toContain("API primer body");
  });

  it("combines all three fields in rule → ref → primer order", () => {
    writeSkill(pluginDir, "rules", "r1", "rule body");
    writeSkill(pluginDir, "references", "p1", "ref body");
    writeSkill(pluginDir, "primers", "d1", "primer body");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "primers:", "  - d1", "rules:", "  - r1", "references:", "  - p1"].join(
        "\n",
      ),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.kind)).toEqual(["rule", "ref", "primer"]);
    expect(out.skills.map((s) => s.id)).toEqual(["r1", "p1", "d1"]);
  });

  it("preserves in-field order", () => {
    writeSkill(pluginDir, "rules", "first", "first");
    writeSkill(pluginDir, "rules", "second", "second");
    writeSkill(pluginDir, "rules", "third", "third");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - second", "  - third", "  - first"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.id)).toEqual(["second", "third", "first"]);
  });

  it("records missing files in unresolved with kind:id format", () => {
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - does-not-exist"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["rule:does-not-exist"]);
  });

  it("ignores a rules: entry that only exists in references/", () => {
    writeSkill(pluginDir, "references", "misfiled", "lives in references\n");
    writeAgent(pluginDir, "engineer", ["name: engineer", "rules:", "  - misfiled"].join("\n"));
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["rule:misfiled"]);
  });

  it("handles agents with no rules/references/primers fields", () => {
    writeAgent(pluginDir, "engineer", "name: engineer");
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
    expect(out.preload_prompt).toBe("");
  });

  it("ignores an unrelated skills: field used for native Claude Code skills", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "canon rule\n");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "skills:",
        "  - some-native-skill",
        "rules:",
        "  - agent-tdd-required",
      ].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.id)).toEqual(["agent-tdd-required"]);
    expect(out.unresolved).toHaveLength(0);
  });

  it("strips a canon: prefix from agent_name", () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - agent-tdd-required"].join("\n"),
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
        "rules:",
        "  - agent-tdd-required",
        "references:",
        "  - status-protocol",
      ].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.preload_prompt).toContain("## Preloaded Skills");
    expect(out.preload_prompt).toContain("### Rule: agent-tdd-required");
    expect(out.preload_prompt).toContain("### Reference: status-protocol");
    expect(out.preload_prompt).toContain("TDD rule body");
    expect(out.preload_prompt).toContain("Status protocol ref body");
    expect(out.preload_prompt).toContain("---");
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

  it("skips non-string entries in rules / references / primers lists", () => {
    writeSkill(pluginDir, "rules", "valid-rule", "valid body");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - valid-rule", "  - 42", "  - {nested: object}"].join("\n"),
    );
    const out = ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].id).toBe("valid-rule");
  });
});
