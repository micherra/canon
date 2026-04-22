/**
 * domain-priming-integration.test.ts
 *
 * Contract tests for the domain priming feature (domain-01, domain-02, domain-03).
 *
 * These tests verify:
 *   - All 6 built-in domain skills exist at the correct paths with correct names
 *   - Domain skills follow the Claude Code skill layout — each is a
 *     self-contained `skills/<name>/` directory with a `SKILL.md` entry point
 *   - SKILL.md has YAML frontmatter with `name` and `description` fields
 *   - The body (after the frontmatter) follows the canonical primer template:
 *     `# <Title> Domain` heading, then Mental Models / Decision Frameworks /
 *     Failure Modes / Guardrails sections
 *   - templates/task-plan.md exposes the `domains:` field to the architect
 *   - canon-architect.md lists all 6 built-in domain names and includes
 *     classification guidance
 *   - canon-implementor.md Step 2 instructs domain loading with correct
 *     fallback paths
 *
 * These are structural/content contract tests — if any are broken by a rename,
 * restructure, or accidental edit, the domain priming pipeline will silently
 * fail.
 *
 * Relocation note (2026-04-22): domain primers moved out of the root-level
 * `domain-primers/` directory and into top-level Claude Code skills at
 * `skills/<name>/SKILL.md` per the Claude Code skill layout
 * (https://code.claude.com/docs/en/skills). Each primer is now a
 * self-contained skill with YAML frontmatter describing when it applies.
 * The body shape is preserved per `templates/domain-primer.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Canon repo root — one level up from mcp-server
const REPO_ROOT = resolve(process.cwd(), "..");

const SKILLS_DIR = join(REPO_ROOT, "skills");
const ARCHITECT_MD = join(REPO_ROOT, "agents", "canon-architect.md");
const IMPLEMENTOR_MD = join(REPO_ROOT, "agents", "canon-implementor.md");
const TASK_PLAN_TEMPLATE = join(REPO_ROOT, "templates", "task-plan.md");

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function skillPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

/**
 * Split a SKILL.md into its frontmatter and body. Returns `null` when no
 * frontmatter is present.
 */
function splitSkill(content: string): { frontmatter: string; body: string } | null {
  if (!content.startsWith("---")) return null;
  const closingIdx = content.indexOf("\n---", 3);
  if (closingIdx === -1) return null;
  const frontmatter = content.slice(3, closingIdx).trim();
  const body = content.slice(closingIdx + 4).replace(/^\n/, "");
  return { body, frontmatter };
}

const BUILT_IN_DOMAINS = [
  "frontend",
  "backend-api",
  "backend-data",
  "infrastructure",
  "testing",
  "deprecation",
] as const;

describe("skill layout — existence", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/${domain}/SKILL.md exists`, () => {
      expect(existsSync(skillPath(domain))).toBe(true);
    });
  }
});

describe("SKILL.md frontmatter — Claude Code skill format", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/${domain}/SKILL.md has YAML frontmatter`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      expect(parts).not.toBeNull();
    });

    it(`skills/${domain}/SKILL.md frontmatter declares a name matching the directory`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      expect(parts).not.toBeNull();
      // name must match the directory name so the /slash-command resolves
      expect(parts?.frontmatter).toContain(`name: ${domain}`);
    });

    it(`skills/${domain}/SKILL.md frontmatter declares a description`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      expect(parts).not.toBeNull();
      expect(parts?.frontmatter).toMatch(/^description:\s*\S/m);
    });
  }
});

describe("SKILL.md body — domain primer template", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/${domain}/SKILL.md body starts with a top-level heading`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      expect(parts).not.toBeNull();
      expect(parts?.body.trimStart().startsWith("# ")).toBe(true);
    });

    it(`skills/${domain}/SKILL.md body contains the required section headings`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      expect(parts).not.toBeNull();
      const body = parts?.body ?? "";
      expect(body).toContain("## Mental Models");
      expect(body).toContain("## Decision Frameworks");
      expect(body).toContain("## Failure Modes");
      expect(body).toContain("## Guardrails");
    });

    it(`skills/${domain}/SKILL.md body contains at least 4 bold terms`, () => {
      const content = readFile(skillPath(domain));
      const parts = splitSkill(content);
      const body = parts?.body ?? "";
      // Each entry is formatted as "**Bold Term** — description" or "**Bold Term**:" (em-dash style)
      const boldItems = (body.match(/\*\*[^*]+\*\*/g) ?? []).length;
      expect(boldItems).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("SKILL.md — approximate token budget (≤ 1750 tokens ≈ 7000 chars)", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/${domain}/SKILL.md is concise (under 7000 characters)`, () => {
      const content = readFile(skillPath(domain));
      expect(content.length).toBeLessThan(7000);
    });
  }
});

describe("templates/task-plan.md — domains: field", () => {
  it("template file exists", () => {
    expect(existsSync(TASK_PLAN_TEMPLATE)).toBe(true);
  });

  it("template contains a domains: field inside the frontmatter block", () => {
    const content = readFile(TASK_PLAN_TEMPLATE);
    expect(content).toContain("domains:");
  });

  it("domains: field appears after principles: field (ordering contract)", () => {
    const content = readFile(TASK_PLAN_TEMPLATE);
    const principlesIdx = content.indexOf("principles:");
    const domainsIdx = content.indexOf("domains:");
    expect(principlesIdx).toBeGreaterThan(-1);
    expect(domainsIdx).toBeGreaterThan(-1);
    expect(domainsIdx).toBeGreaterThan(principlesIdx);
  });
});

describe("canon-architect.md — domain classification guidance", () => {
  it("architect file exists", () => {
    expect(existsSync(ARCHITECT_MD)).toBe(true);
  });

  it("contains domain classification instruction text", () => {
    const content = readFile(ARCHITECT_MD);
    expect(content).toContain("Domain classification");
  });

  it("lists all 6 built-in domain names", () => {
    const content = readFile(ARCHITECT_MD);
    for (const domain of BUILT_IN_DOMAINS) {
      expect(content).toContain(domain);
    }
  });

  it("domain classification guidance appears in Step 7 (before Risk flow rule)", () => {
    const content = readFile(ARCHITECT_MD);
    const domainIdx = content.indexOf("Domain classification");
    const riskIdx = content.indexOf("Risk flow rule");
    expect(domainIdx).toBeGreaterThan(-1);
    expect(riskIdx).toBeGreaterThan(-1);
    // Domain classification must come before the Risk flow rule in Step 7
    expect(domainIdx).toBeLessThan(riskIdx);
  });

  it("references the domains: frontmatter field implementors read", () => {
    const content = readFile(ARCHITECT_MD);
    expect(content).toContain("domains:");
  });
});

describe("canon-implementor.md — Step 2 domain priming", () => {
  it("implementor file exists", () => {
    expect(existsSync(IMPLEMENTOR_MD)).toBe(true);
  });

  it("contains Step 2 labeled as domain priming", () => {
    const content = readFile(IMPLEMENTOR_MD);
    expect(content).toContain("Step 2: Load domain priming");
  });

  it("Step 2 references the plan's domains: frontmatter field", () => {
    const content = readFile(IMPLEMENTOR_MD);
    expect(content).toContain("domains:");
  });

  it("Step 2 specifies project-specific override path (.canon/domains/)", () => {
    const content = readFile(IMPLEMENTOR_MD);
    expect(content).toContain(".canon/domains/");
  });

  it("Step 2 specifies built-in fallback path (CLAUDE_PLUGIN_ROOT/skills/{name}/SKILL.md)", () => {
    const content = readFile(IMPLEMENTOR_MD);
    expect(content).toContain("${CLAUDE_PLUGIN_ROOT}/skills/");
    expect(content).toContain("SKILL.md");
  });

  it("Step 2 instructs silent skip when domain file is missing (no NEEDS_CONTEXT)", () => {
    const content = readFile(IMPLEMENTOR_MD);
    // The step must say to skip silently — not fail or report NEEDS_CONTEXT
    expect(content).toContain("skip silently");
  });

  it("Step 2 appears before Step 3 (Load Canon principles)", () => {
    const content = readFile(IMPLEMENTOR_MD);
    const step2Idx = content.indexOf("Step 2: Load domain priming");
    const step3Idx = content.indexOf("Step 3: Load Canon principles");
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeLessThan(step3Idx);
  });

  it("Step 1 (Read your plan) still exists and is before Step 2", () => {
    const content = readFile(IMPLEMENTOR_MD);
    const step1Idx = content.indexOf("Step 1: Read your plan");
    const step2Idx = content.indexOf("Step 2: Load domain priming");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeLessThan(step2Idx);
  });

  it("Context Isolation section lists domain priming files", () => {
    const content = readFile(IMPLEMENTOR_MD);
    // The context isolation section should mention domain priming as received context.
    // The file uses "Domain priming" (capital D) in the bullet list.
    const isolationIdx = content.indexOf("Context Isolation");
    expect(isolationIdx).toBeGreaterThan(-1);
    const afterIsolation = content.slice(isolationIdx).toLowerCase();
    expect(afterIsolation).toContain("domain priming");
  });
});

// These verify that the three changes work together as a coherent pipeline:
// Architect writes domains: in the plan → implementor reads domains: from
// plan → loads domain skill via its SKILL.md.

describe("domain priming pipeline coherence", () => {
  it("all 6 domain names in architect guidance match actual skill directory names", () => {
    const architectContent = readFile(ARCHITECT_MD);
    for (const domain of BUILT_IN_DOMAINS) {
      expect(architectContent).toContain(domain);
    }
  });

  it("implementor fallback path matches actual skills/<name>/SKILL.md layout", () => {
    // The implementor references CLAUDE_PLUGIN_ROOT/skills/{name}/SKILL.md.
    // Every named skill must exist at that path.
    const implementorContent = readFile(IMPLEMENTOR_MD);
    expect(implementorContent).toContain("/skills/");
    expect(implementorContent).toContain("SKILL.md");
    for (const domain of BUILT_IN_DOMAINS) {
      expect(existsSync(skillPath(domain))).toBe(true);
    }
  });

  it("task-plan template domains: field example uses a built-in domain name", () => {
    const templateContent = readFile(TASK_PLAN_TEMPLATE);
    // The template should show an example value that is a real domain name
    // e.g. "- frontend" under the domains: field
    const hasSampleDomain = BUILT_IN_DOMAINS.some((domain) => {
      // Look for the domain name appearing after "domains:" in the template
      const domainsIdx = templateContent.indexOf("domains:");
      if (domainsIdx === -1) return false;
      const afterDomains = templateContent.slice(domainsIdx, domainsIdx + 200);
      return afterDomains.includes(domain);
    });
    expect(hasSampleDomain).toBe(true);
  });
});
