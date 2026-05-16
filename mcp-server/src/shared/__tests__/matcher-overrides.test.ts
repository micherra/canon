import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllPrinciples } from "../matcher.ts";
import { parsePrinciple } from "../parser.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function principleContent(id: string, severity: string, layers: string[] = []): string {
  const layerList = layers.length > 0 ? layers.join(", ") : "";
  return `---
id: ${id}
title: Test ${id}
severity: ${severity}
scope:
  layers: [${layerList}]
  file_patterns: []
tags: []
---

Body for ${id}.
`;
}

async function createPrincipleDir(base: string): Promise<void> {
  await mkdir(join(base, ".canon", "principles", "rules"), { recursive: true });
  await mkdir(join(base, ".canon", "principles", "strong-opinions"), { recursive: true });
  await mkdir(join(base, ".canon", "principles", "conventions"), { recursive: true });
}

async function createPluginDir(base: string): Promise<string> {
  const pluginDir = join(base, "plugin");
  await mkdir(join(pluginDir, "principles", "rules"), { recursive: true });
  await mkdir(join(pluginDir, "principles", "strong-opinions"), { recursive: true });
  await mkdir(join(pluginDir, "principles", "conventions"), { recursive: true });
  return pluginDir;
}

// ---------------------------------------------------------------------------
// Principle overrides — integration tests via loadAllPrinciples
// ---------------------------------------------------------------------------

describe("principle overrides", () => {
  let projectDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    // Use unique temp dirs per test to avoid cache interference
    projectDir = await mkdtemp(join(tmpdir(), "canon-test-"));
    await createPrincipleDir(projectDir);
    pluginDir = await createPluginDir(projectDir);
  });

  afterEach(async () => {
    await rm(projectDir, { force: true, recursive: true });
  });

  it("no override file — principles unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "beta.md"),
      principleContent("beta", "convention"),
    );

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    expect(principles.map((p) => p.id)).toContain("alpha");
    expect(principles.map((p) => p.id)).toContain("beta");
    expect(principles.find((p) => p.id === "alpha")?.severity).toBe("strong-opinion");
    expect(principles.find((p) => p.id === "beta")?.severity).toBe("convention");
  });

  it("disable action removes principle", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "beta.md"),
      principleContent("beta", "convention"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "gamma.md"),
      principleContent("gamma", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: beta
    action: disable
    reason: Not applicable to this project
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    expect(principles.map((p) => p.id)).toContain("alpha");
    expect(principles.map((p) => p.id)).toContain("gamma");
    expect(principles.map((p) => p.id)).not.toContain("beta");
  });

  it("override-severity changes severity", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: override-severity
    severity: convention
    reason: Downgraded for this project
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.severity).toBe("convention");
  });

  it("narrow-scope replaces scope entirely", async () => {
    const content = `---
id: alpha
title: Test alpha
severity: strong-opinion
scope:
  layers: [api, ui]
  file_patterns: []
tags: []
---

Body for alpha.
`;
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      content,
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: narrow-scope
    applies_to:
      layers: [api]
      file_patterns: ["src/services/**"]
    reason: Narrowed for this project
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.scope.layers).toEqual(["api"]);
    expect(alpha?.scope.file_patterns).toEqual(["src/services/**"]);
    // Replace semantics: tags from original scope must NOT carry over
    expect(alpha?.scope.tags).toBeUndefined();
  });

  it("invalid principle_id silently skipped", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: nonexistent-id
    action: disable
    reason: Does not exist
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    // No error; all existing principles returned
    expect(principles.map((p) => p.id)).toContain("alpha");
  });

  it("malformed YAML silently returns no overrides", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    // Invalid YAML content
    await writeFile(
      join(projectDir, ".canon", "principle-overrides.yaml"),
      "overrides: [invalid: : yaml: ::",
    );

    // Must not throw; all principles returned unchanged
    const principles = await loadAllPrinciples(projectDir, pluginDir);
    expect(principles.map((p) => p.id)).toContain("alpha");
  });

  it("multiple overrides on different principles applied correctly", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "rules", "rule-one.md"),
      principleContent("rule-one", "rule"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "opinion-one.md"),
      principleContent("opinion-one", "strong-opinion"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "conv-one.md"),
      principleContent("conv-one", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: rule-one
    action: disable
    reason: Not used
  - principle_id: opinion-one
    action: override-severity
    severity: convention
    reason: Downgraded
  - principle_id: conv-one
    action: narrow-scope
    applies_to:
      layers: [data]
      file_patterns: []
    reason: Narrowed
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);

    expect(principles.map((p) => p.id)).not.toContain("rule-one");

    const opinion = principles.find((p) => p.id === "opinion-one");
    expect(opinion?.severity).toBe("convention");

    const conv = principles.find((p) => p.id === "conv-one");
    expect(conv?.scope.layers).toEqual(["data"]);
    expect(conv?.scope.file_patterns).toEqual([]);
  });

  it("override file mtime changes cache key — second call returns updated results", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "beta.md"),
      principleContent("beta", "convention"),
    );

    // First call: no override file
    const first = await loadAllPrinciples(projectDir, pluginDir);
    expect(first.map((p) => p.id)).toContain("beta");

    // Write override file (introduces new mtime → different cache key)
    // Small delay to ensure mtime differs
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(
      join(projectDir, ".canon", "principle-overrides.yaml"),
      `overrides:\n  - principle_id: beta\n    action: disable\n    reason: Test cache\n`,
    );

    // Touch the override file to update mtime
    const { utimes } = await import("node:fs/promises");
    const now = new Date(Date.now() + 1000);
    await utimes(join(projectDir, ".canon", "principle-overrides.yaml"), now, now);

    const second = await loadAllPrinciples(projectDir, pluginDir);
    expect(second.map((p) => p.id)).not.toContain("beta");
  });

  it("unknown action silently passes principle through unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: unknown-action
    reason: Unknown
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.severity).toBe("convention");
  });

  // ---------------------------------------------------------------------------
  // reason field validation (Fix 2: validate-at-trust-boundaries)
  // ---------------------------------------------------------------------------

  it("disable entry missing reason is silently dropped — principle unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    // No reason field — should be filtered out, principle kept
    const overrideYaml = `overrides:
  - principle_id: alpha
    action: disable
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    // Override dropped — principle still present
    expect(principles.map((p) => p.id)).toContain("alpha");
  });

  it("disable entry with empty reason is silently dropped — principle unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: disable
    reason: ""
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    expect(principles.map((p) => p.id)).toContain("alpha");
  });

  it("override-severity entry missing reason is silently dropped — severity unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );

    // No reason field — should be filtered out, severity kept
    const overrideYaml = `overrides:
  - principle_id: alpha
    action: override-severity
    severity: convention
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    // Override dropped — severity unchanged
    expect(alpha?.severity).toBe("strong-opinion");
  });

  it("override-severity entry with empty reason is silently dropped — severity unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: override-severity
    severity: convention
    reason: ""
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.severity).toBe("strong-opinion");
  });

  it("disable entry with valid reason is applied", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: disable
    reason: Not applicable to this project
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    // Valid reason — override applied, principle removed
    expect(principles.map((p) => p.id)).not.toContain("alpha");
  });

  it("narrow-scope entry missing applies_to is silently skipped — principle unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "conventions", "alpha.md"),
      principleContent("alpha", "convention", ["api", "ui"]),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: narrow-scope
    reason: Missing applies_to field
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    // Override skipped — scope unchanged
    expect(alpha?.scope.layers).toEqual(["api", "ui"]);
  });

  it("override-severity entry with invalid severity value is silently skipped — principle unchanged", async () => {
    await writeFile(
      join(projectDir, ".canon", "principles", "strong-opinions", "alpha.md"),
      principleContent("alpha", "strong-opinion"),
    );

    const overrideYaml = `overrides:
  - principle_id: alpha
    action: override-severity
    severity: critical
    reason: Invalid severity value
`;
    await writeFile(join(projectDir, ".canon", "principle-overrides.yaml"), overrideYaml);

    const principles = await loadAllPrinciples(projectDir, pluginDir);
    const alpha = principles.find((p) => p.id === "alpha");
    expect(alpha).toBeDefined();
    // Override skipped — severity unchanged
    expect(alpha?.severity).toBe("strong-opinion");
  });
});

// ---------------------------------------------------------------------------
// parsePrinciple scope.tags
// ---------------------------------------------------------------------------

describe("parsePrinciple scope.tags", () => {
  it("extracts scope.tags from frontmatter", () => {
    const content = `---
id: test-principle
title: Test
severity: convention
scope:
  layers: []
  tags:
    - error-handling
    - reliability
tags: []
---

Body text.
`;
    const p = parsePrinciple(content, "test.md");
    expect(p.scope.tags).toEqual(["error-handling", "reliability"]);
  });

  it("returns undefined scope.tags when not present in frontmatter", () => {
    const content = `---
id: test-principle
title: Test
severity: convention
scope:
  layers: []
tags: []
---

Body text.
`;
    const p = parsePrinciple(content, "test.md");
    expect(p.scope.tags).toBeUndefined();
  });

  it("returns undefined scope.tags when scope block is absent", () => {
    const content = `---
id: test-principle
title: Test
severity: convention
tags: []
---

Body text.
`;
    const p = parsePrinciple(content, "test.md");
    expect(p.scope.tags).toBeUndefined();
  });
});
