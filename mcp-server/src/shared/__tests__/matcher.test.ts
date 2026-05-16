import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferLayer, loadAllPrinciples, matchPrinciples } from "../matcher.ts";
import { parsePrinciple } from "../parser.ts";
import type { Principle } from "../parser.ts";

// Extended overrides tests (with reason validation) are in matcher-overrides.test.ts

function makePrinciple(overrides: Partial<Principle> = {}): Principle {
  return {
    archived: false,
    body: "Body",
    filePath: "test.md",
    id: "test",
    scope: { file_patterns: [], layers: [] },
    severity: "convention",
    tags: [],
    title: "Test",
    ...overrides,
  };
}

describe("inferLayer", () => {
  it("infers api from routes path", () => {
    expect(inferLayer("src/routes/users.ts")).toBe("api");
  });

  it("infers api from controllers path", () => {
    expect(inferLayer("src/controllers/auth.ts")).toBe("api");
  });

  it("infers ui from app path (Next.js)", () => {
    expect(inferLayer("src/app/page.tsx")).toBe("ui");
    expect(inferLayer("src/app/dashboard/page.tsx")).toBe("ui");
    expect(inferLayer("src/app/layout.tsx")).toBe("ui");
  });

  it("infers ui from components path", () => {
    expect(inferLayer("src/components/Button.tsx")).toBe("ui");
  });

  it("infers ui from pages path", () => {
    expect(inferLayer("src/pages/Home.tsx")).toBe("ui");
  });

  it("infers domain from services path", () => {
    expect(inferLayer("src/services/UserService.ts")).toBe("domain");
  });

  it("infers data from db path", () => {
    expect(inferLayer("src/db/migrations/001.sql")).toBe("data");
  });

  it("infers infra from terraform path", () => {
    expect(inferLayer("infra/terraform/main.tf")).toBe("infra");
  });

  it("infers shared from utils path", () => {
    expect(inferLayer("src/utils/helpers.ts")).toBe("shared");
  });

  it("returns undefined for unrecognized paths", () => {
    expect(inferLayer("src/main.ts")).toBeUndefined();
  });
});

describe("matchPrinciples", () => {
  it("returns all non-archived principles when no filters", () => {
    const principles = [makePrinciple({ id: "a" }), makePrinciple({ id: "b" })];
    const result = matchPrinciples(principles, {});
    expect(result).toHaveLength(2);
  });

  it("excludes archived principles", () => {
    const principles = [
      makePrinciple({ id: "active" }),
      makePrinciple({ archived: true, id: "archived" }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("active");
  });

  it("includes archived principles when include_archived is true", () => {
    const principles = [
      makePrinciple({ id: "active" }),
      makePrinciple({ archived: true, id: "archived" }),
    ];
    const result = matchPrinciples(principles, { include_archived: true });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toContain("archived");
  });

  it("filters by layer", () => {
    const principles = [
      makePrinciple({ id: "api-only", scope: { file_patterns: [], layers: ["api"] } }),
      makePrinciple({ id: "ui-only", scope: { file_patterns: [], layers: ["ui"] } }),
      makePrinciple({ id: "any-layer", scope: { file_patterns: [], layers: [] } }),
    ];
    const result = matchPrinciples(principles, { layers: ["api"] });
    expect(result.map((p) => p.id)).toEqual(["api-only", "any-layer"]);
  });

  it("infers layer from file_path", () => {
    const principles = [
      makePrinciple({ id: "api-rule", scope: { file_patterns: [], layers: ["api"] } }),
      makePrinciple({ id: "ui-rule", scope: { file_patterns: [], layers: ["ui"] } }),
    ];
    const result = matchPrinciples(principles, { file_path: "src/routes/users.ts" });
    expect(result.map((p) => p.id)).toEqual(["api-rule"]);
  });

  it("matches file patterns with glob", () => {
    const principles = [
      makePrinciple({
        id: "tf-only",
        scope: { file_patterns: ["**/*.tf"], layers: [] },
      }),
      makePrinciple({
        id: "any-file",
        scope: { file_patterns: [], layers: [] },
      }),
    ];
    const result = matchPrinciples(principles, { file_path: "infra/main.tf" });
    expect(result.map((p) => p.id)).toContain("tf-only");
    expect(result.map((p) => p.id)).toContain("any-file");
  });

  it("excludes principles whose file patterns don't match", () => {
    const principles = [
      makePrinciple({
        id: "ts-only",
        scope: { file_patterns: ["**/*.ts"], layers: [] },
      }),
    ];
    const result = matchPrinciples(principles, { file_path: "src/style.css" });
    expect(result).toHaveLength(0);
  });

  it("filters by severity", () => {
    const principles = [
      makePrinciple({ id: "r", severity: "rule" }),
      makePrinciple({ id: "so", severity: "strong-opinion" }),
      makePrinciple({ id: "c", severity: "convention" }),
    ];
    const result = matchPrinciples(principles, { severity_filter: "strong-opinion" });
    expect(result.map((p) => p.id)).toEqual(["r", "so"]);
  });

  it("filters by tags", () => {
    const principles = [
      makePrinciple({ id: "sec", tags: ["security"] }),
      makePrinciple({ id: "test", tags: ["testing"] }),
      makePrinciple({ id: "both", tags: ["security", "testing"] }),
    ];
    const result = matchPrinciples(principles, { tags: ["security"] });
    expect(result.map((p) => p.id)).toEqual(["sec", "both"]);
  });

  it("sorts by severity: rules first, then strong-opinions, then conventions", () => {
    const principles = [
      makePrinciple({ id: "c", severity: "convention" }),
      makePrinciple({ id: "r", severity: "rule" }),
      makePrinciple({ id: "so", severity: "strong-opinion" }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result.map((p) => p.id)).toEqual(["r", "so", "c"]);
  });

  it("breaks severity ties by scope specificity (more file patterns first)", () => {
    const principles = [
      makePrinciple({
        id: "generic",
        scope: { file_patterns: [], layers: [] },
        severity: "rule",
      }),
      makePrinciple({
        id: "specific",
        scope: { file_patterns: ["src/**", "lib/**"], layers: [] },
        severity: "rule",
      }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result[0].id).toBe("specific");
    expect(result[1].id).toBe("generic");
  });

  describe("scope.tags matching (computed_tags)", () => {
    it("matches principle with scope.tags via computed_tags even when layers don't match", () => {
      const principles = [
        makePrinciple({
          id: "error-scoped",
          scope: { file_patterns: [], layers: [], tags: ["error-handling"] },
        }),
      ];
      // computed_tags has error-handling, layers don't match (api vs [])
      const result = matchPrinciples(principles, {
        computed_tags: ["error-handling"],
        layers: ["api"],
      });
      expect(result.map((p) => p.id)).toContain("error-scoped");
    });

    it("falls back to layer matching when computed_tags is undefined", () => {
      const api = makePrinciple({
        id: "api-only",
        scope: { file_patterns: [], layers: ["api"], tags: ["error-handling"] },
      });
      const ui = makePrinciple({
        id: "ui-only",
        scope: { file_patterns: [], layers: ["ui"], tags: ["error-handling"] },
      });
      // No computed_tags — layer-only matching
      const result = matchPrinciples([api, ui], { layers: ["api"] });
      expect(result.map((p) => p.id)).toContain("api-only");
      expect(result.map((p) => p.id)).not.toContain("ui-only");
    });

    it("falls back to layer matching when computed_tags is empty", () => {
      const api = makePrinciple({
        id: "api-only",
        scope: { file_patterns: [], layers: ["api"], tags: ["error-handling"] },
      });
      const result = matchPrinciples([api], { computed_tags: [], layers: ["api"] });
      expect(result.map((p) => p.id)).toContain("api-only");
    });

    it("uses OR semantics: layer match alone is sufficient", () => {
      const p = makePrinciple({
        id: "both",
        scope: { file_patterns: [], layers: ["api"], tags: ["error-handling"] },
      });
      // layers match but computed_tags doesn't intersect
      const result = matchPrinciples([p], {
        computed_tags: ["observability"],
        layers: ["api"],
      });
      expect(result.map((p) => p.id)).toContain("both");
    });

    it("uses OR semantics: tag match alone is sufficient", () => {
      const p = makePrinciple({
        id: "tag-match",
        scope: { file_patterns: [], layers: ["api"], tags: ["error-handling"] },
      });
      // layers don't match but computed_tags does
      const result = matchPrinciples([p], {
        computed_tags: ["error-handling"],
        layers: ["ui"],
      });
      expect(result.map((p) => p.id)).toContain("tag-match");
    });

    it("excludes principle when neither layer nor scope.tags match", () => {
      const p = makePrinciple({
        id: "no-match",
        scope: { file_patterns: [], layers: ["api"], tags: ["error-handling"] },
      });
      const result = matchPrinciples([p], {
        computed_tags: ["observability"],
        layers: ["ui"],
      });
      expect(result).toHaveLength(0);
    });

    it("principles without scope.tags are unaffected by computed_tags", () => {
      const p = makePrinciple({
        id: "no-scope-tags",
        scope: { file_patterns: [], layers: [] },
      });
      // No scope.tags → always matches (layer check: empty scope.layers → true)
      const result = matchPrinciples([p], { computed_tags: ["anything"] });
      expect(result.map((p) => p.id)).toContain("no-scope-tags");
    });

    it("tag-only principle (empty layers) does NOT match when computed_tags differ", () => {
      // Bug 1 regression test: empty scope.layers must NOT cause universal match
      // when scope.tags is non-empty.
      const p = makePrinciple({
        id: "tag-only",
        scope: { file_patterns: [], layers: [], tags: ["authentication"] },
      });
      // File has "observability" tag — NOT "authentication"
      const result = matchPrinciples([p], {
        computed_tags: ["observability"],
        layers: ["api"],
      });
      expect(result).toHaveLength(0);
    });

    it("tag-only principle (empty layers) matches when computed_tags contain the tag", () => {
      const p = makePrinciple({
        id: "tag-only-auth",
        scope: { file_patterns: [], layers: [], tags: ["authentication"] },
      });
      // File has "authentication" tag
      const result = matchPrinciples([p], {
        computed_tags: ["authentication", "observability"],
        layers: ["api"],
      });
      expect(result.map((p) => p.id)).toContain("tag-only-auth");
    });

    it("tag-only principle (empty layers) is skipped when no computed_tags available (KG not indexed)", () => {
      const p = makePrinciple({
        id: "tag-only-skipped",
        scope: { file_patterns: [], layers: [], tags: ["authentication"] },
      });
      // No computed_tags (KG not indexed) — principle should be skipped
      const result = matchPrinciples([p], { layers: ["api"] });
      expect(result).toHaveLength(0);
    });

    it("universal principle (empty layers, empty tags) still matches everything", () => {
      const p = makePrinciple({
        id: "universal",
        scope: { file_patterns: [], layers: [] },
      });
      // No scope.tags → always matches regardless of computed_tags
      const result = matchPrinciples([p], { computed_tags: [], layers: ["ui"] });
      expect(result.map((p) => p.id)).toContain("universal");
    });
  });
});

// ---------------------------------------------------------------------------
// Principle overrides — integration tests via loadAllPrinciples
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

describe("principle overrides", () => {
  let projectDir: string;
  let pluginDir: string;
  let loadAllPrinciples: typeof import("../matcher.ts")["loadAllPrinciples"];

  beforeEach(async () => {
    // Use unique temp dirs per test to avoid cache interference
    projectDir = await mkdtemp(join(tmpdir(), "canon-test-"));
    await createPrincipleDir(projectDir);
    pluginDir = await createPluginDir(projectDir);
    // Reset module registry so the module-level principleCache is fresh for each test
    vi.resetModules();
    ({ loadAllPrinciples } = await import("../matcher.ts"));
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
