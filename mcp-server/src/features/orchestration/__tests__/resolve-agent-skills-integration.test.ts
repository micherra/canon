/**
 * resolve-agent-skills-integration.test.ts
 *
 * Integration: every shipped agent in `agents/` must resolve its entire
 * `skills:` list against the real `rules/`, `references/`, `primers/`
 * directories. Any `unresolved` entry is a typo or a missing rule/ref file.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolveAgentSkillsResult } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");

function listAgents(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
}

function agentFrontmatterSkills(agentName: string): string[] {
  const raw = readFileSync(join(AGENTS_DIR, `${agentName}.md`), "utf-8");
  const parsed = matter(raw);
  return Array.isArray(parsed.data.skills) ? parsed.data.skills : [];
}

describe("resolve_agent_skills against shipped agents", () => {
  const agents = listAgents();

  it("discovers at least the 11 Gate-A agents", () => {
    expect(agents.length).toBeGreaterThanOrEqual(11);
    for (const expected of [
      "architect",
      "engineer",
      "learner",
      "planner",
      "researcher",
      "reviewer",
      "scribe",
      "security",
      "shipper",
      "tester",
      "writer",
    ]) {
      expect(agents).toContain(expected);
    }
  });

  for (const name of listAgents()) {
    it(`${name}: every skills: entry resolves`, () => {
      const result = resolveAgentSkills({ agent_name: name }, REPO_ROOT);
      assertOk<ResolveAgentSkillsResult>(result);
      const declared = agentFrontmatterSkills(name);
      expect(result.unresolved).toEqual([]);
      expect(result.skills.length).toBe(declared.length);
    });

    it(`${name}: skills use prefixed IDs (rule: / ref: / primer:)`, () => {
      const declared = agentFrontmatterSkills(name);
      for (const id of declared) {
        expect(
          id.startsWith("rule:") || id.startsWith("ref:") || id.startsWith("primer:"),
          `${name} skill '${id}' is missing a rule:/ref:/primer: prefix`,
        ).toBe(true);
      }
    });
  }
});
