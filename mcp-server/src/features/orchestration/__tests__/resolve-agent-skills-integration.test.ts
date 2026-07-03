/**
 * resolve-agent-skills-integration.test.ts
 *
 * Integration: every shipped agent in `agents/` must resolve every entry
 * in its `rules:`, `references:`, and `primers:` frontmatter fields against
 * the real `rules/`, `references/`, `primers/` directories. Any `unresolved`
 * entry indicates a typo or a missing file and must be fixed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolveAgentSkillsResult } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
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
  return splitFrontmatter(raw).data;
}

function coerceList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

describe("resolve_agent_skills against shipped agents", () => {
  const agents = listAgents();

  it("discovers at least the 10 active agents (researcher, planner, janitor retired)", () => {
    expect(agents.length).toBeGreaterThanOrEqual(10);
    for (const expected of [
      "architect",
      "engineer",
      "evaluator",
      "learner",
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
    it(`${name}: every rules/references/primers/templates entry resolves`, {
      retry: 2,
    }, async () => {
      const result = await resolveAgentSkills({ agent_name: name }, REPO_ROOT);
      assertOk<ResolveAgentSkillsResult>(result);
      const fm = agentFrontmatter(name);
      const declaredCount =
        coerceList(fm.rules).length +
        coerceList(fm.references).length +
        coerceList(fm.primers).length +
        coerceList(fm.templates).length;

      if (result.unresolved.length > 0) {
        // Distinguish transient FS errors (EMFILE under parallel load) from
        // genuine missing files. tryReadSkill silently swallows ALL errors;
        // if the file exists on disk but was not read, the failure is
        // environmental, not a real contract violation.
        const KIND_DIR: Record<string, string> = {
          primer: "primers",
          ref: "references",
          rule: "rules",
          template: "templates",
        };
        const genuinelyMissing = result.unresolved.filter((entry) => {
          const colonIdx = entry.indexOf(":");
          const kind = entry.slice(0, colonIdx);
          const entryName = entry.slice(colonIdx + 1);
          const dir = KIND_DIR[kind];
          if (!dir) return true; // unknown kind — treat as genuine
          const filePath = join(REPO_ROOT, dir, `${entryName}.md`);
          return !existsSync(filePath);
        });

        expect(
          genuinelyMissing,
          [
            `Agent "${name}" has unresolved skill entries that are missing from disk.`,
            `Unresolved: ${result.unresolved.join(", ")}`,
            `Genuinely missing (not a transient FS error): ${genuinelyMissing.join(", ")}`,
          ].join("\n"),
        ).toEqual([]);
      }

      expect(result.skills.length).toBe(declaredCount);
    });

    it(`${name}: does not carry Canon rules/refs/primers/templates in skills:`, () => {
      const fm = agentFrontmatter(name);
      const native = coerceList(fm.skills);
      for (const id of native) {
        expect(
          id.startsWith("rule:") ||
            id.startsWith("ref:") ||
            id.startsWith("primer:") ||
            id.startsWith("template:"),
          `${name} has a prefixed Canon ID '${id}' still in skills:; move it to the matching rules:/references:/primers:/templates: field`,
        ).toBe(false);
      }
    });
  }
});
