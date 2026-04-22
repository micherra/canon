/**
 * domain-priming-integration.test.ts
 *
 * Contract tests for the domain priming feature (domain-01, domain-02, domain-03).
 *
 * These tests verify:
 *   - All 6 built-in domain primers exist at the correct paths with correct names
 *   - Domain primer files contain no YAML frontmatter (implementors load them as raw text)
 *   - Domain primer files follow the canonical primer template
 *     (Mental Models / Decision Frameworks / Failure Modes / Guardrails)
 *   - templates/task-plan.md exposes the `domains:` field to the architect
 *   - architect.md lists all 6 built-in domain names and includes
 *     classification guidance
 *   - implementor.md Step 2 instructs domain loading with correct
 *     fallback paths
 *
 * These are structural/content contract tests — if any are broken by a rename,
 * restructure, or accidental edit, the domain priming pipeline will silently
 * fail.
 *
 * Relocation note (2026-04-22): domain primers live at
 * `skills/canon/references/<name>.md` — raw markdown, consumed by Canon
 * subagents via Read per the agent-context-check protocol. They are NOT
 * Claude Code skills (no `SKILL.md` wrapper, no YAML frontmatter): a
 * subagent's `Read` tool loads the whole file, so frontmatter would just
 * be noise. The 22 agent-rule symlinks in the same directory are the
 * other content of `references/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Canon repo root — one level up from mcp-server
const REPO_ROOT = resolve(process.cwd(), "..");

const DOMAINS_DIR = join(REPO_ROOT, "skills", "canon", "references");
const ARCHITECT_MD = join(REPO_ROOT, "agents", "architect.md");
const IMPLEMENTOR_MD = join(REPO_ROOT, "agents", "implementor.md");
const TASK_PLAN_TEMPLATE = join(REPO_ROOT, "templates", "task-plan.md");

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

const BUILT_IN_DOMAINS = [
  "frontend",
  "backend-api",
  "backend-data",
  "infrastructure",
  "testing",
  "deprecation",
] as const;

describe("domain files — existence", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/canon/references/${domain}.md exists`, () => {
      expect(existsSync(join(DOMAINS_DIR, `${domain}.md`))).toBe(true);
    });
  }

  // NOTE: skills/canon/references/ intentionally holds more than the 6
  // built-in domain primers — it also holds the 6 new agent-teams domain
  // skills, 22 rule symlinks, and orchestrator reference fragments. We
  // assert that the 6 required primers are present; we do NOT assert the
  // directory is otherwise empty (it isn't, by design).
});

describe("domain files — no YAML frontmatter", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/canon/references/${domain}.md does not start with YAML frontmatter delimiter`, () => {
      const content = readFile(join(DOMAINS_DIR, `${domain}.md`));
      // A file with frontmatter starts with "---\n". Primers are loaded as
      // raw markdown by Canon subagents; frontmatter would be noise.
      expect(content.startsWith("---")).toBe(false);
    });
  }
});

describe("domain files — heading format", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/canon/references/${domain}.md starts with a top-level heading`, () => {
      const content = readFile(join(DOMAINS_DIR, `${domain}.md`));
      expect(content.trimStart().startsWith("# ")).toBe(true);
    });

    it(`skills/canon/references/${domain}.md contains the required section headings`, () => {
      const content = readFile(join(DOMAINS_DIR, `${domain}.md`));
      expect(content).toContain("## Mental Models");
      expect(content).toContain("## Decision Frameworks");
      expect(content).toContain("## Failure Modes");
      expect(content).toContain("## Guardrails");
    });

    it(`skills/canon/references/${domain}.md contains at least 4 bold terms`, () => {
      const content = readFile(join(DOMAINS_DIR, `${domain}.md`));
      // Each entry is formatted as "**Bold Term** — description" or "**Bold Term**:" (em-dash style)
      const boldItems = (content.match(/\*\*[^*]+\*\*/g) ?? []).length;
      expect(boldItems).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("domain files — approximate token budget (≤ 1750 tokens ≈ 7000 chars)", () => {
  for (const domain of BUILT_IN_DOMAINS) {
    it(`skills/canon/references/${domain}.md is concise (under 7000 characters)`, () => {
      const content = readFile(join(DOMAINS_DIR, `${domain}.md`));
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

describe("architect.md — domain classification guidance", () => {
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

describe("implementor.md — Step 2 domain priming", () => {
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

  it("Step 2 specifies built-in fallback path (CLAUDE_PLUGIN_ROOT/skills/canon/references/)", () => {
    const content = readFile(IMPLEMENTOR_MD);
    expect(content).toContain("${CLAUDE_PLUGIN_ROOT}/skills/canon/references/");
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
// plan → loads domain file from skills/canon/references/.

describe("domain priming pipeline coherence", () => {
  it("all 6 domain names in architect guidance match actual domain file names", () => {
    const architectContent = readFile(ARCHITECT_MD);
    for (const domain of BUILT_IN_DOMAINS) {
      expect(architectContent).toContain(domain);
    }
  });

  it("implementor fallback path matches actual skills/canon/references/ layout", () => {
    // The implementor references CLAUDE_PLUGIN_ROOT/skills/canon/references/{name}.md.
    // Every named primer must exist at that path.
    const implementorContent = readFile(IMPLEMENTOR_MD);
    expect(implementorContent).toContain("/skills/canon/references/");
    for (const domain of BUILT_IN_DOMAINS) {
      expect(existsSync(join(DOMAINS_DIR, `${domain}.md`))).toBe(true);
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
