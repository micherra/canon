/**
 * resolve-agent-skills-integration.test.ts
 *
 * Integration: every shipped agent in `agents/` must resolve every entry
 * in its `rules:`, `references:`, and `primers:` frontmatter fields against
 * the real `rules/`, `references/`, `primers/` directories. Any `unresolved`
 * entry indicates a typo or a missing file and must be fixed.
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

function agentFrontmatter(agentName: string): Record<string, unknown> {
  const raw = readFileSync(join(AGENTS_DIR, `${agentName}.md`), "utf-8");
  return matter(raw).data;
}

function coerceList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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
    it(`${name}: every rules/references/primers entry resolves`, () => {
      const result = resolveAgentSkills({ agent_name: name }, REPO_ROOT);
      assertOk<ResolveAgentSkillsResult>(result);
      const fm = agentFrontmatter(name);
      const declaredCount =
        coerceList(fm.rules).length +
        coerceList(fm.references).length +
        coerceList(fm.primers).length;
      expect(result.unresolved).toEqual([]);
      expect(result.skills.length).toBe(declaredCount);
    });

    it(`${name}: does not carry Canon rules/refs/primers in skills:`, () => {
      const fm = agentFrontmatter(name);
      const native = coerceList(fm.skills);
      for (const id of native) {
        expect(
          id.startsWith("rule:") || id.startsWith("ref:") || id.startsWith("primer:"),
          `${name} has a prefixed Canon ID '${id}' still in skills:; move it to the matching rules:/references:/primers: field`,
        ).toBe(false);
      }
    });
  }
});
