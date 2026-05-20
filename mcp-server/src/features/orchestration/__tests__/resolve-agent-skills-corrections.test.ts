import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ResolveAgentSkillsResult,
  resolveAgentSkills,
} from "@features/orchestration/tools/resolve-agent-skills.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function ok(
  result: ReturnType<typeof resolveAgentSkills>,
): Promise<{ ok: true } & ResolveAgentSkillsResult> {
  const resolved = await result;
  assertOk<ResolveAgentSkillsResult>(resolved);
  return resolved;
}

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-skills-corrections-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  mkdirSync(join(pluginDir, "templates"));
  return pluginDir;
}

function seedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canon-project-corrections-"));
  return dir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(join(pluginDir, "agents", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

function writeCorrection(
  projectDir: string,
  fileName: string,
  record: {
    file_path: string;
    commit_sha: string;
    commit_subject: string;
    agent_type: string;
    correction_command: string;
    timestamp: string;
  },
) {
  const dir = join(projectDir, ".canon", "corrections");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify(record));
}

function recentTimestamp(offsetMs = 0): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

describe("resolveAgentSkills — correction injection", () => {
  let pluginDir: string;
  let projectDir: string;

  beforeEach(() => {
    pluginDir = seedPluginDir();
    projectDir = seedProjectDir();
    // Set up a minimal agent that has no skills
    writeAgent(pluginDir, "engineer", "name: engineer");
  });

  afterEach(() => {
    rmSync(pluginDir, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("without projectDir does not include corrections section", async () => {
    // Write a correction to make sure it's not picked up without projectDir
    writeCorrection(projectDir, "c1.json", {
      agent_type: "engineer",
      commit_sha: "abc12345",
      commit_subject: "feat: add foo",
      correction_command: "git commit --amend",
      file_path: "src/foo.ts",
      timestamp: recentTimestamp(),
    });
    // Call without projectDir
    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    expect(result.preload_prompt).not.toContain("Recent User Corrections");
  });

  it("with projectDir and no corrections returns normal preload_prompt without corrections section", async () => {
    // projectDir exists but has no .canon/corrections directory
    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));
    // Should not include corrections section
    expect(result.preload_prompt).not.toContain("Recent User Corrections");
  });

  it("with projectDir and corrections includes Recent User Corrections section in preload_prompt", async () => {
    writeCorrection(projectDir, "c1.json", {
      agent_type: "engineer",
      commit_sha: "abc12345def",
      commit_subject: "feat: add important feature",
      correction_command: "git commit --amend --no-edit",
      file_path: "src/important.ts",
      timestamp: recentTimestamp(),
    });
    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));
    expect(result.preload_prompt).toContain("Recent User Corrections");
    expect(result.preload_prompt).toContain("src/important.ts");
    expect(result.preload_prompt).toContain("abc12345"); // truncated sha
    expect(result.preload_prompt).toContain("feat: add important feature");
    expect(result.preload_prompt).toContain("git commit --amend --no-edit");
  });

  it("with projectDir, corrections section appended after skills section", async () => {
    writeFileSync(join(pluginDir, "rules", "some-rule.md"), "Rule body");
    writeAgent(pluginDir, "engineer", ["name: engineer", "rules:", "  - some-rule"].join("\n"));
    writeCorrection(projectDir, "c1.json", {
      agent_type: "engineer",
      commit_sha: "abc12345",
      commit_subject: "feat: foo",
      correction_command: "git commit --amend",
      file_path: "src/foo.ts",
      timestamp: recentTimestamp(),
    });
    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));
    // Both sections present
    expect(result.preload_prompt).toContain("## Preloaded Skills");
    expect(result.preload_prompt).toContain("## Recent User Corrections");
    // Skills section comes before corrections section
    const skillsIdx = result.preload_prompt.indexOf("## Preloaded Skills");
    const corrIdx = result.preload_prompt.indexOf("## Recent User Corrections");
    expect(skillsIdx).toBeLessThan(corrIdx);
  });

  it("succeeds even when corrections directory contains malformed files (non-blocking)", async () => {
    // Write a malformed correction file
    const dir = join(projectDir, ".canon", "corrections");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not valid json at all!!!");
    // resolveAgentSkills should still succeed
    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));
    // No corrections section because all files are malformed
    expect(result.preload_prompt).not.toContain("Recent User Corrections");
  });

  it("preload_prompt is unaffected when projectDir has no corrections (only skills)", async () => {
    writeFileSync(join(pluginDir, "rules", "agent-tdd-required.md"), "TDD rule body");
    writeAgent(
      pluginDir,
      "engineer",
      ["name: engineer", "rules:", "  - agent-tdd-required"].join("\n"),
    );
    // No corrections
    const withProjectDir = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir),
    );
    const withoutProjectDir = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    // Both should produce the same preload_prompt when there are no corrections
    expect(withProjectDir.preload_prompt).toBe(withoutProjectDir.preload_prompt);
  });
});
