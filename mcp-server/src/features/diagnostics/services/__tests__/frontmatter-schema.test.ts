/**
 * Tests for the per-class frontmatter schema check (R1, ADR-0021).
 *
 * Two layers:
 * 1. Unit — the pure `checkFrontmatterSchema` over synthetic fixtures: a valid
 *    one-of-each-class set passes; typo'd / missing-key / malformed-YAML / wrong-shape
 *    fixtures produce SCHEMA_ERROR or PARSE_ERROR findings.
 * 2. Whole-corpus — `classifyFmClass` + `checkFrontmatterSchema` over the REAL
 *    principles/, agents/, templates/, docs/adr/ trees must report ZERO findings
 *    (no false positives on the clean corpus — AC). A real finding is a true defect,
 *    not a reason to weaken the schema.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFrontmatterSchema,
  classifyFmClass,
  type FrontmatterSchemaInput,
} from "../frontmatter-schema.ts";

// ---- Unit fixtures ----

const VALID_PRINCIPLE = `id: example-principle
title: Example Principle
severity: convention
scope:
  layers: []
  file_patterns: []
  tags: []
tags: []
`;

const VALID_AGENT = `name: example-agent
description: An example agent.
model: sonnet
color: blue
maxTurns: 40
rules:
  - some-rule
`;

const VALID_TEMPLATE = `template: example
description: An example template.
used-by:
  - architect
read-by:
  - engineer
output-path: plans/example.md
`;

const VALID_ADR = `adr: "0042"
title: An Example Decision
status: accepted
date: "2026-06-21"
build: some-build
`;

describe("checkFrontmatterSchema — valid fixtures (one of each class)", () => {
  it("returns zero findings for valid principle/agent/template/adr frontmatter", () => {
    const files: FrontmatterSchemaInput[] = [
      {
        fm_class: "principle",
        path: "principles/conventions/example.md",
        rawFrontmatter: VALID_PRINCIPLE,
      },
      { fm_class: "agent", path: "agents/example-agent.md", rawFrontmatter: VALID_AGENT },
      { fm_class: "template", path: "templates/example.md", rawFrontmatter: VALID_TEMPLATE },
      { fm_class: "adr", path: "docs/adr/0042-example.md", rawFrontmatter: VALID_ADR },
    ];
    expect(checkFrontmatterSchema(files)).toEqual([]);
  });
});

describe("checkFrontmatterSchema — invalid fixtures flagged", () => {
  it("typo'd severity (rül) → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/typo.md",
        rawFrontmatter: VALID_PRINCIPLE.replace("severity: convention", "severity: rül"),
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/severity/);
  });

  it("malformed YAML block → PARSE_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/malformed.md",
        rawFrontmatter: "bad: : indent\n  unclosed: [\n",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("PARSE_ERROR");
  });

  it("missing required id → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/no-id.md",
        rawFrontmatter: VALID_PRINCIPLE.replace("id: example-principle\n", ""),
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/id/);
  });

  it("ADR with non-4-digit adr number → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "adr",
        path: "docs/adr/42-example.md",
        rawFrontmatter: VALID_ADR.replace('adr: "0042"', 'adr: "42"'),
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/adr/);
  });

  it("malformed scope (scalar instead of map) → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/bad-scope.md",
        rawFrontmatter: `id: bad-scope
title: Bad Scope
severity: convention
scope: not-a-map
tags: []
`,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/scope/);
  });
});

describe("classifyFmClass — directory-prefix resolution", () => {
  it("classifies principle / agent / template / adr by path", () => {
    expect(classifyFmClass("principles/rules/foo.md")).toBe("principle");
    expect(classifyFmClass(".canon/principles/conventions/bar.md")).toBe("principle");
    expect(classifyFmClass("agents/architect.md")).toBe("agent");
    expect(classifyFmClass("templates/prd.md")).toBe("template");
    expect(classifyFmClass("docs/adr/0001-foo.md")).toBe("adr");
  });

  it("returns null for non-classified paths (loops/routines excluded — own validation)", () => {
    expect(classifyFmClass("loops/ship-watch.md")).toBeNull();
    expect(classifyFmClass("routines/foo.md")).toBeNull();
    expect(classifyFmClass("docs/adr/README.md")).toBeNull();
    expect(classifyFmClass("docs/adr/TEMPLATE.md")).toBeNull();
    expect(classifyFmClass("principles/conventions/README.md")).toBeNull();
    expect(classifyFmClass("README.md")).toBeNull();
  });

  // Dot-dir exclusion boundary: only `.canon/` is exempt; other dot-dirs return null.
  it("dot-dir skip: principles/.claude/CLAUDE.md → null (tooling doc, not schema-bearing)", () => {
    // `.claude` is a dot-dir other than `.canon` — must be skipped.
    expect(classifyFmClass("principles/.claude/CLAUDE.md")).toBeNull();
  });

  it("dot-dir skip: .github/CODEOWNERS → null", () => {
    expect(classifyFmClass(".github/CODEOWNERS")).toBeNull();
  });

  it("dot-dir pass: .canon/principles/conventions/internal.md → principle (exempt dot-dir)", () => {
    // `.canon/` is explicitly exempted: `.canon/principles/` is a real principle tree.
    expect(classifyFmClass(".canon/principles/conventions/internal.md")).toBe("principle");
  });

  it("ADR path without 4-digit prefix → null (classifyFmClass does not validate adr number)", () => {
    // The path pattern requires `docs/adr/NNNN-*.md`; a non-numeric prefix does not match.
    expect(classifyFmClass("docs/adr/some-decision.md")).toBeNull();
  });
});

describe("checkFrontmatterSchema — per-class malformed fixtures", () => {
  it("agent missing required 'name' field → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "agent",
        path: "agents/missing-name.md",
        // Remove the 'name' key from an otherwise valid agent frontmatter.
        rawFrontmatter: `description: An example agent.
model: sonnet
rules:
  - some-rule
`,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/name/);
  });

  it("template missing required 'template' field → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "template",
        path: "templates/missing-template.md",
        rawFrontmatter: `description: A template without the template key.
used-by:
  - architect
`,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/template/);
  });

  it("ADR with invalid status value → SCHEMA_ERROR", () => {
    const findings = checkFrontmatterSchema([
      {
        fm_class: "adr",
        path: "docs/adr/0099-bad-status.md",
        rawFrontmatter: `adr: "0099"
title: Bad Status ADR
status: draft
date: "2026-06-24"
build: some-build
`,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    expect(findings[0].message).toMatch(/status/);
  });

  it("principle with scope.layers as a scalar string → SCHEMA_ERROR (must be array)", () => {
    // A common typo: `layers: hooks` instead of `layers: [hooks]`.
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/scalar-layers.md",
        rawFrontmatter: `id: scalar-layers-principle
title: Scalar Layers
severity: convention
scope:
  layers: hooks
`,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SCHEMA_ERROR");
    // Zod reports the path as scope.layers.
    expect(findings[0].message).toMatch(/scope\.layers|layers/);
  });

  it("empty rawFrontmatter string (no fence in file) → no finding (skip, not error)", () => {
    // The tool layer passes "" when the file has no frontmatter fence; the service
    // must treat this as "skip" rather than "schema error for missing required fields".
    const findings = checkFrontmatterSchema([
      {
        fm_class: "principle",
        path: "principles/conventions/prose-template.md",
        rawFrontmatter: "",
      },
    ]);
    expect(findings).toHaveLength(0);
  });

  it("whitespace-only rawFrontmatter → no finding (same skip rule as empty string)", () => {
    // A fence that contains only whitespace parses to null → coalesced to {}.
    // But .trim().length === 0 hits the early-return skip in checkOne — no finding.
    const findings = checkFrontmatterSchema([
      {
        fm_class: "template",
        path: "templates/whitespace-only.md",
        rawFrontmatter: "   \n  \n",
      },
    ]);
    expect(findings).toHaveLength(0);
  });
});

// ---- Whole-corpus no-false-positive assertion (AC) ----

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");

/** Recursively collect .md files under a directory (best-effort; missing dir → []). */
function collectMd(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...collectMd(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("checkFrontmatterSchema — whole real corpus (zero false positives)", () => {
  it("reports no findings against the real principles/agents/templates/docs/adr trees", () => {
    const dirs = ["principles", ".canon/principles", "agents", "templates", "docs/adr"];
    const inputs: FrontmatterSchemaInput[] = [];
    for (const rel of dirs) {
      for (const full of collectMd(join(REPO_ROOT, rel))) {
        const repoRel = full
          .slice(REPO_ROOT.length + 1)
          .split("\\")
          .join("/");
        const fmClass = classifyFmClass(repoRel);
        if (!fmClass) continue;
        const content = readFileSync(full, "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
        inputs.push({ fm_class: fmClass, path: repoRel, rawFrontmatter: match ? match[1] : "" });
      }
    }

    // Sanity: we actually found a corpus (guards against an empty-input pass).
    expect(inputs.length).toBeGreaterThan(10);

    const findings = checkFrontmatterSchema(inputs);
    // If this fails, the message names the offending file(s) — a true defect to fix,
    // not a reason to weaken the schema.
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
