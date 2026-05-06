import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrinciples, getPrinciplesBatch } from "../tools/get-principles.ts";

describe("getPrinciples", () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-gp-test-"));
    pluginDir = join(tmpDir, "plugin");

    // Create a plugin dir with a few test principles
    const rulesDir = join(pluginDir, "principles", "rules");
    const opinionsDir = join(pluginDir, "principles", "strong-opinions");
    const conventionsDir = join(pluginDir, "principles", "conventions");
    await mkdir(rulesDir, { recursive: true });
    await mkdir(opinionsDir, { recursive: true });
    await mkdir(conventionsDir, { recursive: true });

    await writeFile(
      join(rulesDir, "r1.md"),
      `---\nid: r1\ntitle: Rule One\nseverity: rule\n---\n\nRule body paragraph one.\n\n## Rationale\n\nMore detail here.`,
    );
    await writeFile(
      join(opinionsDir, "so1.md"),
      `---\nid: so1\ntitle: Opinion One\nseverity: strong-opinion\n---\n\nOpinion body.`,
    );
    await writeFile(
      join(conventionsDir, "c1.md"),
      `---\nid: c1\ntitle: Convention One\nseverity: convention\n---\n\nConvention body.`,
    );

    // Create project .canon dir
    await mkdir(join(tmpDir, ".canon", "principles", "rules"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, ".canon", "principles", "strong-opinions"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, ".canon", "principles", "conventions"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns principles up to the default cap", async () => {
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles.length).toBeLessThanOrEqual(10);
    expect(result.total_in_canon).toBe(3);
  });

  it("respects a valid max_principles_per_review config", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: 1 } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles).toHaveLength(1);
    expect(result.total_matched).toBe(3);
  });

  it("falls back to default for non-numeric config value", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: "banana" } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    // Should use default (10), returning all 3
    expect(result.principles).toHaveLength(3);
  });

  it("falls back to default for zero", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: 0 } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles).toHaveLength(3);
  });

  it("falls back to default for negative number", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: -5 } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles).toHaveLength(3);
  });

  it("falls back to default for Infinity", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: "Infinity" } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles).toHaveLength(3);
  });

  it("floors fractional values", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: 1.9 } }),
    );
    const result = await getPrinciples({}, tmpDir, pluginDir);
    expect(result.principles).toHaveLength(1);
  });

  it("returns summary_only with just the first paragraph", async () => {
    const result = await getPrinciples({ summary_only: true }, tmpDir, pluginDir);
    const rule = result.principles.find((p) => p.id === "r1");
    expect(rule).toBeDefined();
    expect(rule!.body).toBe("Rule body paragraph one.");
    expect(rule!.body).not.toContain("## Rationale");
  });

  it("returns full body when summary_only is false", async () => {
    const result = await getPrinciples({ summary_only: false }, tmpDir, pluginDir);
    const rule = result.principles.find((p) => p.id === "r1");
    expect(rule!.body).toContain("## Rationale");
  });

  describe("sections filter", () => {
    beforeEach(async () => {
      // Add a principle with known sections
      const rulesDir = join(pluginDir, "principles", "rules");
      await writeFile(
        join(rulesDir, "r-with-sections.md"),
        [
          "---",
          "id: r-sections",
          "title: Rule With Sections",
          "severity: rule",
          "---",
          "",
          "Summary paragraph here.",
          "",
          "More body text.",
          "",
          "## Anti-Rationalization",
          "",
          "| Excuse | Rebuttal |",
          "| --- | --- |",
          "| It's fast | Correctness first |",
          "",
          "## Verification",
          "",
          "Run: `npm test`",
        ].join("\n"),
      );
    });

    it("returns full body (with sections) when sections is omitted", async () => {
      const result = await getPrinciples({}, tmpDir, pluginDir);
      const p = result.principles.find((p) => p.id === "r-sections");
      expect(p).toBeDefined();
      expect(p!.body).toContain("## Anti-Rationalization");
      expect(p!.body).toContain("## Verification");
      expect(p!.body).toContain("Summary paragraph here.");
    });

    it("returns only summary + requested sections when sections is provided", async () => {
      const result = await getPrinciples({ sections: ["verification"] }, tmpDir, pluginDir);
      const p = result.principles.find((p) => p.id === "r-sections");
      expect(p).toBeDefined();
      expect(p!.body).toContain("Summary paragraph here.");
      expect(p!.body).toContain("## Verification");
      expect(p!.body).not.toContain("## Anti-Rationalization");
    });

    it("summary_only takes precedence over sections", async () => {
      const result = await getPrinciples(
        { sections: ["verification"], summary_only: true },
        tmpDir,
        pluginDir,
      );
      const p = result.principles.find((p) => p.id === "r-sections");
      expect(p).toBeDefined();
      // summary_only returns only the first paragraph — no sections appended
      expect(p!.body).toBe("Summary paragraph here.");
      expect(p!.body).not.toContain("## Verification");
    });

    it("returns summary + verification section when sections: ['verification']", async () => {
      const result = await getPrinciples({ sections: ["verification"] }, tmpDir, pluginDir);
      const p = result.principles.find((p) => p.id === "r-sections");
      expect(p!.body).toContain("Summary paragraph here.");
      expect(p!.body).toContain("Run: `npm test`");
    });

    it("returns summary + anti_rationalization when sections: ['anti_rationalization']", async () => {
      const result = await getPrinciples({ sections: ["anti_rationalization"] }, tmpDir, pluginDir);
      const p = result.principles.find((p) => p.id === "r-sections");
      expect(p!.body).toContain("Summary paragraph here.");
      expect(p!.body).toContain("## Anti-Rationalization");
      expect(p!.body).not.toContain("## Verification");
    });

    it("returns summary only when principle lacks the requested section", async () => {
      // so1 has no Anti-Rationalization or Verification sections
      const result = await getPrinciples({ sections: ["verification"] }, tmpDir, pluginDir);
      const so1 = result.principles.find((p) => p.id === "so1");
      expect(so1).toBeDefined();
      // Body should be just the summary (first paragraph), no section headings
      expect(so1!.body).toBe("Opinion body.");
      expect(so1!.body).not.toContain("##");
    });
  });
});

describe("getPrinciplesBatch", () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-gpb-test-"));
    pluginDir = join(tmpDir, "plugin");

    const rulesDir = join(pluginDir, "principles", "rules");
    const opinionsDir = join(pluginDir, "principles", "strong-opinions");
    const conventionsDir = join(pluginDir, "principles", "conventions");
    await mkdir(rulesDir, { recursive: true });
    await mkdir(opinionsDir, { recursive: true });
    await mkdir(conventionsDir, { recursive: true });

    await writeFile(
      join(rulesDir, "r1.md"),
      `---\nid: r1\ntitle: Rule One\nseverity: rule\n---\n\nRule body paragraph one.\n\n## Rationale\n\nMore detail here.`,
    );
    await writeFile(
      join(opinionsDir, "so1.md"),
      `---\nid: so1\ntitle: Opinion One\nseverity: strong-opinion\n---\n\nOpinion body.`,
    );
    await writeFile(
      join(conventionsDir, "c1.md"),
      `---\nid: c1\ntitle: Convention One\nseverity: convention\n---\n\nConvention body.`,
    );

    await mkdir(join(tmpDir, ".canon", "principles", "rules"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "strong-opinions"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "conventions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns deduplicated principles across multiple files", async () => {
    const result = await getPrinciplesBatch(
      { file_paths: ["src/features/principles/tools/get-principles.ts", "src/shared/matcher.ts"] },
      tmpDir,
      pluginDir,
    );
    // All 3 principles are returned exactly once (deduplicated by ID)
    expect(result.total_in_canon).toBe(3);
    const ids = result.principles.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("returns graph_context_by_file keyed by each file path", async () => {
    const filePaths = ["src/a.ts", "src/b.ts"];
    const result = await getPrinciplesBatch({ file_paths: filePaths }, tmpDir, pluginDir);
    // Both file paths appear as keys in graph_context_by_file
    expect(Object.keys(result.graph_context_by_file)).toEqual(expect.arrayContaining(filePaths));
    expect(Object.keys(result.graph_context_by_file)).toHaveLength(filePaths.length);
  });

  it("handles empty file_paths array gracefully", async () => {
    const result = await getPrinciplesBatch({ file_paths: [] }, tmpDir, pluginDir);
    expect(result.principles).toBeDefined();
    expect(Array.isArray(result.principles)).toBe(true);
    expect(result.graph_context_by_file).toEqual({});
    expect(result.total_in_canon).toBeGreaterThan(0);
  });

  it("applies summary_only formatting to all returned principles", async () => {
    const result = await getPrinciplesBatch(
      { file_paths: ["src/a.ts"], summary_only: true },
      tmpDir,
      pluginDir,
    );
    const rule = result.principles.find((p) => p.id === "r1");
    expect(rule).toBeDefined();
    expect(rule!.body).toBe("Rule body paragraph one.");
    expect(rule!.body).not.toContain("## Rationale");
  });

  it("applies sections filtering to all returned principles", async () => {
    // Add a principle with sections
    const rulesDir = join(pluginDir, "principles", "rules");
    await writeFile(
      join(rulesDir, "r-sections.md"),
      [
        "---",
        "id: r-sections",
        "title: Rule With Sections",
        "severity: rule",
        "---",
        "",
        "Summary paragraph here.",
        "",
        "## Anti-Rationalization",
        "",
        "| Excuse | Rebuttal |",
        "| --- | --- |",
        "| It's fast | Correctness first |",
        "",
        "## Verification",
        "",
        "Run: `npm test`",
      ].join("\n"),
    );

    const result = await getPrinciplesBatch(
      { file_paths: ["src/a.ts"], sections: ["verification"] },
      tmpDir,
      pluginDir,
    );
    const p = result.principles.find((p) => p.id === "r-sections");
    expect(p).toBeDefined();
    expect(p!.body).toContain("Summary paragraph here.");
    expect(p!.body).toContain("## Verification");
    expect(p!.body).not.toContain("## Anti-Rationalization");
  });

  it("returns graph_context_by_file with undefined values when KG DB is absent", async () => {
    const result = await getPrinciplesBatch({ file_paths: ["src/a.ts"] }, tmpDir, pluginDir);
    // When no KG DB exists, graph_context_by_file values should be undefined
    expect(result.graph_context_by_file["src/a.ts"]).toBeUndefined();
  });

  it("caps results at max_principles_per_review config value", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_principles_per_review: 1 } }),
    );
    const result = await getPrinciplesBatch({ file_paths: ["src/a.ts"] }, tmpDir, pluginDir);
    // Should be capped at 1 even though 3 principles exist
    expect(result.principles).toHaveLength(1);
    // total_matched still reflects all matched before cap
    expect(result.total_matched).toBe(3);
  });

  it("uses default cap of 10 when no config is set", async () => {
    const result = await getPrinciplesBatch({ file_paths: ["src/a.ts"] }, tmpDir, pluginDir);
    // 3 principles exist and all match — all returned (under default cap of 10)
    expect(result.principles.length).toBeLessThanOrEqual(10);
  });
});

/** Insert a file row into the KG store and return its file_id. */
function insertKgFile(store: KgStore, path: string): number {
  const fileRow: Omit<FileRow, "file_id"> = {
    content_hash: `hash-${path}`,
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "api",
    mtime_ms: Date.now(),
    path,
  };
  store.upsertFile(fileRow);
  return store.getFile(path)!.file_id!;
}

describe("getPrinciples — computed_tags from KG", () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-gp-tags-"));
    pluginDir = join(tmpDir, "plugin");

    const rulesDir = join(pluginDir, "principles", "rules");
    const opinionsDir = join(pluginDir, "principles", "strong-opinions");
    await mkdir(rulesDir, { recursive: true });
    await mkdir(opinionsDir, { recursive: true });
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src"), { recursive: true });

    // Principle with no scope.tags — always matches
    await writeFile(
      join(rulesDir, "r-no-tags.md"),
      `---\nid: r-no-tags\ntitle: Rule No Tags\nseverity: rule\n---\n\nUntagged rule always matches.`,
    );

    // Principle with scope.tags = ["authentication"] — only matches files tagged "authentication"
    await writeFile(
      join(opinionsDir, "so-auth.md"),
      `---\nid: so-auth\ntitle: Auth Opinion\nseverity: strong-opinion\nscope:\n  tags:\n    - authentication\n---\n\nAuth-specific opinion.`,
    );

    // Create a source file
    await writeFile(join(tmpDir, "src", "handler.ts"), `export function handleRequest() {}`);

    // Project .canon dirs
    await mkdir(join(tmpDir, ".canon", "principles", "rules"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "strong-opinions"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "conventions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns results (graceful degradation) when no KG database exists", async () => {
    // No DB file — KG unavailable
    const result = await getPrinciples({ file_path: "src/handler.ts" }, tmpDir, pluginDir);
    // Should still return principles without erroring
    expect(result.principles.length).toBeGreaterThan(0);
    expect(result.total_in_canon).toBe(2);
  });

  it("includes principle with matching scope.tags when file has the matching computed_tag", async () => {
    // Set up KG with "authentication" tag on the file
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileId = insertKgFile(store, "src/handler.ts");
    store.upsertFileTag({
      confidence: 1.0,
      file_id: fileId,
      source: "test",
      tag: "authentication",
    });
    db.close();

    const result = await getPrinciples({ file_path: "src/handler.ts" }, tmpDir, pluginDir);

    const ids = result.principles.map((p) => p.id);
    expect(ids).toContain("so-auth");
  });

  it("excludes principle when file's layer AND tags both fail to match", async () => {
    // Add a principle restricted to "data" layer AND "database" tag
    const opinionsDir = join(pluginDir, "principles", "strong-opinions");
    await writeFile(
      join(opinionsDir, "so-db-tagged.md"),
      [
        "---",
        "id: so-db-tagged",
        "title: DB Tagged Opinion",
        "severity: strong-opinion",
        "scope:",
        "  layers:",
        "    - data",
        "  tags:",
        "    - database",
        "---",
        "",
        "DB-layer opinion requiring database tag.",
      ].join("\n"),
    );

    // File lives in src/routes/ (→ "api" layer by default mapping)
    // so it fails the "data" layer check
    await mkdir(join(tmpDir, "src", "routes"), { recursive: true });
    await writeFile(
      join(tmpDir, "src", "routes", "handler.ts"),
      `export function handleRequest() {}`,
    );

    // File has tag "authentication" — NOT "database" → fails the tag check too
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileId = insertKgFile(store, "src/routes/handler.ts");
    store.upsertFileTag({
      confidence: 1.0,
      file_id: fileId,
      source: "test",
      tag: "authentication",
    });
    db.close();

    const result = await getPrinciples({ file_path: "src/routes/handler.ts" }, tmpDir, pluginDir);

    // so-db-tagged: layer="data" fails (file is "api") AND tag="database" fails
    // Both signals fail → principle excluded
    // r-no-tags: no scope restrictions → always matches
    const ids = result.principles.map((p) => p.id);
    expect(ids).not.toContain("so-db-tagged");
    expect(ids).toContain("r-no-tags");
  });

  it("includes untagged principle regardless of computed_tags", async () => {
    // Set up KG — file tagged "authentication"
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileId = insertKgFile(store, "src/handler.ts");
    store.upsertFileTag({
      confidence: 1.0,
      file_id: fileId,
      source: "test",
      tag: "authentication",
    });
    db.close();

    const result = await getPrinciples({ file_path: "src/handler.ts" }, tmpDir, pluginDir);

    const ids = result.principles.map((p) => p.id);
    // Untagged principle always matches
    expect(ids).toContain("r-no-tags");
  });

  it("excludes tag-only principle when file has NO matching computed_tag", async () => {
    // Set up KG — file tagged "observability" (NOT "authentication")
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileId = insertKgFile(store, "src/handler.ts");
    store.upsertFileTag({
      confidence: 1.0,
      file_id: fileId,
      source: "test",
      tag: "observability",
    });
    db.close();

    const result = await getPrinciples({ file_path: "src/handler.ts" }, tmpDir, pluginDir);

    const ids = result.principles.map((p) => p.id);
    // so-auth requires "authentication" tag — file has "observability" → should NOT match
    expect(ids).not.toContain("so-auth");
    // r-no-tags (no scope restrictions) should still match
    expect(ids).toContain("r-no-tags");
  });
});
