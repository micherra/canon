import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveAgentSkillsResult } from "@features/orchestration/tools/resolve-agent-skills.ts";
import {
  applyAgentSkillsDisclosure,
  summarizeAgentSkills,
} from "@features/orchestration/tools/resolve-agent-skills-disclosure.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeResult(overrides: Partial<ResolveAgentSkillsResult> = {}): ResolveAgentSkillsResult {
  return {
    agent_name: "engineer",
    preload_prompt: "short prompt",
    skills: [
      { content: "rule body", id: "agent-tdd-required", kind: "rule", path: "/rules/r1.md" },
      { content: "ref body", id: "status-protocol", kind: "ref", path: "/references/p1.md" },
      { content: "primer body", id: "backend-api", kind: "primer", path: "/primers/d1.md" },
      {
        content: "template body",
        id: "implementation-log",
        kind: "template",
        path: "/templates/t1.md",
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

describe("summarizeAgentSkills", () => {
  it("produces compact summary with agent name, kind counts, and skill names", () => {
    const result = makeResult();
    const summary = summarizeAgentSkills(result);

    expect(summary).toContain("Agent: engineer");
    expect(summary).toContain("Rules: 1");
    expect(summary).toContain("References: 1");
    expect(summary).toContain("Primers: 1");
    expect(summary).toContain("Templates: 1");
    expect(summary).toContain("- rule: agent-tdd-required");
    expect(summary).toContain("- ref: status-protocol");
    expect(summary).toContain("- primer: backend-api");
    expect(summary).toContain("- template: implementation-log");
  });

  it("includes unresolved skills when present", () => {
    const result = makeResult({ unresolved: ["rule:missing-rule", "ref:missing-ref"] });
    const summary = summarizeAgentSkills(result);

    expect(summary).toContain("Unresolved:");
    expect(summary).toContain("- rule:missing-rule");
    expect(summary).toContain("- ref:missing-ref");
  });

  it("omits unresolved section when empty", () => {
    const result = makeResult({ unresolved: [] });
    const summary = summarizeAgentSkills(result);

    expect(summary).not.toContain("Unresolved:");
  });

  it("counts multiple skills per kind correctly", () => {
    const result = makeResult({
      skills: [
        { content: "body1", id: "rule1", kind: "rule", path: "/r1.md" },
        { content: "body2", id: "rule2", kind: "rule", path: "/r2.md" },
        { content: "body3", id: "rule3", kind: "rule", path: "/r3.md" },
      ],
    });
    const summary = summarizeAgentSkills(result);

    expect(summary).toContain("Rules: 3");
    expect(summary).toContain("References: 0");
    expect(summary).toContain("Primers: 0");
    expect(summary).toContain("Templates: 0");
  });
});

describe("applyAgentSkillsDisclosure", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "canon-disclosure-"));
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("passes through small results unchanged", async () => {
    const result = makeResult({ preload_prompt: "short" });
    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);

    // Should be the exact same object reference (no truncation)
    expect(disclosed).toBe(result);
    expect(disclosed.preload_prompt).toBe("short");
    expect(disclosed.full_data_path).toBeUndefined();
  });

  it("truncates large results and replaces preload_prompt with summary + file pointer", async () => {
    // Create a preload_prompt over the 12k threshold
    const bigPrompt = "x".repeat(13_000);
    const result = makeResult({ preload_prompt: bigPrompt });

    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);

    expect(disclosed).not.toBe(result);
    expect(disclosed.preload_prompt).not.toContain("x".repeat(100));
    expect(disclosed.preload_prompt).toContain("Agent: engineer");
    expect(disclosed.preload_prompt).toContain("Full preload content at:");
    expect(disclosed.preload_prompt).toContain(
      "Instruct the agent to Read this file path for the complete rules, references, primers, and templates.",
    );
    expect(disclosed.full_data_path).toBeDefined();
  });

  it("clears skill content fields when truncated", async () => {
    const bigPrompt = "y".repeat(13_000);
    const result = makeResult({ preload_prompt: bigPrompt });

    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);

    for (const skill of disclosed.skills) {
      expect(skill.content).toBe("");
    }
    // IDs and kinds are preserved
    expect(disclosed.skills.map((s) => s.id)).toEqual([
      "agent-tdd-required",
      "status-protocol",
      "backend-api",
      "implementation-log",
    ]);
  });

  it("writes full JSON to disk at full_data_path when truncated", async () => {
    const bigPrompt = "z".repeat(13_000);
    const result = makeResult({ preload_prompt: bigPrompt });

    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);

    expect(disclosed.full_data_path).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
    const filePath = disclosed.full_data_path!;
    expect(existsSync(filePath)).toBe(true);

    const fileContent = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(fileContent) as ResolveAgentSkillsResult;

    // Full original preload_prompt is in the JSON
    expect(parsed.preload_prompt).toBe(bigPrompt);
    // Full skill content is in the JSON
    expect(parsed.skills[0].content).toBe("rule body");
    expect(parsed.agent_name).toBe("engineer");
  });
});
