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
  mkdirSync(join(pluginDir, "templates"));
  return pluginDir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(join(pluginDir, "agents", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

function writeSkill(
  pluginDir: string,
  kind: "rules" | "references" | "primers" | "templates",
  id: string,
  body: string,
) {
  writeFileSync(join(pluginDir, kind, `${id}.md`), body);
}

async function ok(
  result: ReturnType<typeof resolveAgentSkills>,
): Promise<{ ok: true } & ResolveAgentSkillsResult> {
  const resolved = await result;
  assertOk<ResolveAgentSkillsResult>(resolved);
  return resolved;
}

describe("resolveAgentSkills", () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = seedPluginDir();
  });

  afterEach(() => {
    rmSync(pluginDir, { force: true, recursive: true });
  });

  it("loads rules: entries from rules/<name>.md", async () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "TDD rule body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - agent-tdd-required"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].kind).toBe("rule");
    expect(out.skills[0].id).toBe("agent-tdd-required");
    expect(out.skills[0].content).toContain("TDD rule body");
    expect(out.unresolved).toHaveLength(0);
  });

  it("loads references: entries from references/<name>.md", async () => {
    writeSkill(pluginDir, "references", "status-protocol", "Status protocol ref body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "references:", "  - status-protocol"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("ref");
    expect(out.skills[0].content).toContain("Status protocol ref body");
  });

  it("loads primers: entries from primers/<name>.md", async () => {
    writeSkill(pluginDir, "primers", "backend-api", "API primer body\n");
    writeAgent(pluginDir, "engineer", ["name: engineer", "primers:", "  - backend-api"].join("\n"));
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills[0].kind).toBe("primer");
    expect(out.skills[0].content).toContain("API primer body");
  });

  it("loads templates: entries from templates/<name>.md", async () => {
    writeSkill(pluginDir, "templates", "planning-brief", "Planning brief template body\n");
    writeAgent(
      pluginDir,
      "planner",
      ["name: planner", "templates:", "  - planning-brief"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "planner" }, pluginDir));
    expect(out.skills[0].kind).toBe("template");
    expect(out.skills[0].content).toContain("Planning brief template body");
  });

  it("combines all four fields in rule → ref → primer → template order", async () => {
    writeSkill(pluginDir, "rules", "r1", "rule body");
    writeSkill(pluginDir, "references", "p1", "ref body");
    writeSkill(pluginDir, "primers", "d1", "primer body");
    writeSkill(pluginDir, "templates", "t1", "template body");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "templates:",
        "  - t1",
        "primers:",
        "  - d1",
        "rules:",
        "  - r1",
        "references:",
        "  - p1",
      ].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.kind)).toEqual(["rule", "ref", "primer", "template"]);
    expect(out.skills.map((s) => s.id)).toEqual(["r1", "p1", "d1", "t1"]);
  });

  it("preserves in-field order", async () => {
    writeSkill(pluginDir, "rules", "first", "first");
    writeSkill(pluginDir, "rules", "second", "second");
    writeSkill(pluginDir, "rules", "third", "third");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - second", "  - third", "  - first"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.id)).toEqual(["second", "third", "first"]);
  });

  it("records missing files in unresolved with kind:id format", async () => {
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - does-not-exist"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["rule:does-not-exist"]);
  });

  it("ignores a rules: entry that only exists in references/", async () => {
    writeSkill(pluginDir, "references", "misfiled", "lives in references\n");
    writeAgent(pluginDir, "engineer", ["name: engineer", "rules:", "  - misfiled"].join("\n"));
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toEqual(["rule:misfiled"]);
  });

  it("handles agents with no rules/references/primers/templates fields", async () => {
    writeAgent(pluginDir, "engineer", "name: engineer");
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
    expect(out.preload_prompt).toBe("");
  });

  it("ignores an unrelated skills: field used for native Claude Code skills", async () => {
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
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills.map((s) => s.id)).toEqual(["agent-tdd-required"]);
    expect(out.unresolved).toHaveLength(0);
  });

  it("strips a canon: prefix from agent_name", async () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "body\n");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - agent-tdd-required"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "canon:engineer" }, pluginDir));
    expect(out.agent_name).toBe("engineer");
    expect(out.skills).toHaveLength(1);
  });

  it("produces a preload_prompt with section headers and separators for all kinds", async () => {
    writeSkill(pluginDir, "rules", "agent-tdd-required", "TDD rule body");
    writeSkill(pluginDir, "references", "status-protocol", "Status protocol ref body");
    writeSkill(pluginDir, "templates", "implementation-log", "Implementation log template");
    writeAgent(
      pluginDir,
      "engineer",
      [
        "name: engineer",
        "rules:",
        "  - agent-tdd-required",
        "references:",
        "  - status-protocol",
        "templates:",
        "  - implementation-log",
      ].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.preload_prompt).toContain("## Preloaded Skills");
    expect(out.preload_prompt).toContain("### Rule: agent-tdd-required");
    expect(out.preload_prompt).toContain("### Reference: status-protocol");
    expect(out.preload_prompt).toContain("### Template: implementation-log");
    expect(out.preload_prompt).toContain("TDD rule body");
    expect(out.preload_prompt).toContain("Status protocol ref body");
    expect(out.preload_prompt).toContain("Implementation log template");
    expect(out.preload_prompt).toContain("---");
  });

  it("returns INVALID_INPUT when agent file is missing", async () => {
    const result = await resolveAgentSkills({ agent_name: "nonexistent" }, pluginDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("Agent file not found");
    }
  });

  it("returns INVALID_INPUT for agent_name with invalid characters", async () => {
    const result = await resolveAgentSkills({ agent_name: "../etc/passwd" }, pluginDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("skips non-string entries in rules / references / primers lists", async () => {
    writeSkill(pluginDir, "rules", "valid-rule", "valid body");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - valid-rule", "  - 42", "  - {nested: object}"].join("\n"),
    );
    const out = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].id).toBe("valid-rule");
  });
});
