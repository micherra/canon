/**
 * kg-adapter-markdown.test.ts
 *
 * Unit tests for the markdown language adapter's specifier extraction,
 * conservative backtick-path grammar, and doc:references tagging.
 *
 * Pipeline-level test: verifies that doc:references edges persist to SQLite
 * after runPipeline and that metric queries (degree) are unaffected.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { markdownAdapter } from "../kg-adapter-markdown.ts";
import { resolveImports } from "../kg-pipeline-phases.ts";
import { KgQuery } from "../kg-query.ts";

// --- Adapter unit tests ---

describe("markdownAdapter — conservative backtick-path grammar", () => {
  test("slashed backtick path with known extension is included as doc:references", () => {
    const content = `
# Bounded Context Map

See \`mcp-server/src/graph/kg-store.ts\` for storage details.
`;
    const result = markdownAdapter.parse("docs/bounded-context-map.md", content);
    const specifiers = result.importSpecifiers;
    const spec = specifiers.find((s) => s.specifier === "mcp-server/src/graph/kg-store.ts");
    expect(spec).toBeDefined();
    expect(spec?.edgeType).toBe("doc:references");
    expect(spec?.names).toEqual([]);
  });

  test("slash-less filename (no slash in path) produces NO specifier", () => {
    const content = `
See \`flow-schema.ts\` for the schema.
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    const paths = result.importSpecifiers.map((s) => s.specifier);
    expect(paths).not.toContain("flow-schema.ts");
  });

  test("bare identifier produces NO specifier", () => {
    const content = `
The \`KgStore\` class handles persistence.
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    const paths = result.importSpecifiers.map((s) => s.specifier);
    expect(paths).not.toContain("KgStore");
  });

  test("template path with ${VAR} produces NO specifier", () => {
    const content = `
See \`${"{"}WORKSPACE}/foo.ts\` for the workspace path.
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    const paths = result.importSpecifiers.map((s) => s.specifier);
    // No specifier should contain ${ (template syntax)
    for (const p of paths) {
      expect(p).not.toMatch(/\$\{/);
    }
    expect(paths.filter((p) => p.includes("WORKSPACE"))).toHaveLength(0);
  });

  test("http:// link URL produces NO specifier (filtered by isRelativePath)", () => {
    const content = `
See [external](https://example.com/foo.ts) for details.
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    const paths = result.importSpecifiers.map((s) => s.specifier);
    expect(paths.filter((p) => p.startsWith("https://"))).toHaveLength(0);
  });

  test("relative link URL is tagged as doc:references", () => {
    const content = `
See [index](../mcp-server/src/app/index.ts) for the entry point.
`;
    const result = markdownAdapter.parse("docs/bounded-context-map.md", content);
    const spec = result.importSpecifiers.find(
      (s) => s.specifier === "../mcp-server/src/app/index.ts",
    );
    expect(spec).toBeDefined();
    expect(spec?.edgeType).toBe("doc:references");
  });

  test("frontmatter includes field produces untagged specifier (no edgeType)", () => {
    const content = `---
includes: ./other-doc.md
---

# Doc
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    const spec = result.importSpecifiers.find((s) => s.specifier === "./other-doc.md");
    expect(spec).toBeDefined();
    // Frontmatter refs are untagged (no edgeType field)
    expect(spec?.edgeType).toBeUndefined();
  });

  test("combined fixture: slashed backtick + relative link + slash-less + template", () => {
    const content = `---
title: Bounded Context Map
---

# Map

See \`mcp-server/src/graph/kg-store.ts\` for storage.
See \`flow-schema.ts\` for schema (no slash — excluded).
See \`${"{"}VAR}/foo.ts\` for template path (excluded).

Link to [index](../mcp-server/src/app/index.ts).
`;
    const result = markdownAdapter.parse("docs/bounded-context-map.md", content);

    // Slashed backtick path should be included with edgeType
    const backtickSpec = result.importSpecifiers.find(
      (s) => s.specifier === "mcp-server/src/graph/kg-store.ts",
    );
    expect(backtickSpec).toBeDefined();
    expect(backtickSpec?.edgeType).toBe("doc:references");

    // Relative link should be included with edgeType
    const linkSpec = result.importSpecifiers.find(
      (s) => s.specifier === "../mcp-server/src/app/index.ts",
    );
    expect(linkSpec).toBeDefined();
    expect(linkSpec?.edgeType).toBe("doc:references");

    // Slash-less filename should be absent
    expect(result.importSpecifiers.map((s) => s.specifier)).not.toContain("flow-schema.ts");

    // Template path should be absent
    expect(result.importSpecifiers.filter((s) => s.specifier.includes("VAR"))).toHaveLength(0);
  });

  test("intraFileEdges is always empty", () => {
    const content = `
# Doc

See \`mcp-server/src/graph/kg-store.ts\` and [x](./foo.ts).
`;
    const result = markdownAdapter.parse("docs/map.md", content);
    expect(result.intraFileEdges).toEqual([]);
  });
});

// --- Pipeline-level test: doc:references edge persists and metrics are unaffected ---

describe("pipeline-level — doc:references edges and metric identity", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;
  let tmpDir: string;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
    tmpDir = mkdtempSync(path.join(tmpdir(), "kg-doc-ref-test-"));
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("doc:references edge persists when doc cites a code file root-relatively", () => {
    // Set up fixture: one .ts file + one docs/map.md citing it
    const srcPath = "src/lib/store.ts";
    const docPath = "docs/map.md";

    // Insert source file into DB
    const srcFile = store.upsertFile({
      content_hash: "abc",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: 1000,
      path: srcPath,
    });

    const docFile = store.upsertFile({
      content_hash: "def",
      language: "markdown",
      last_indexed_at: Date.now(),
      layer: "docs",
      mtime_ms: 1000,
      path: docPath,
    });

    const allRelPaths = new Set([srcPath, docPath]);

    // Simulate what parsePhase2 collects from the markdown adapter
    // docs/map.md cites src/lib/store.ts root-relatively in a backtick
    const docContent = `
# Map

See \`src/lib/store.ts\` for storage.
`;
    const adapterResult = markdownAdapter.parse(docPath, docContent);

    // Build fileImports as the pipeline would
    const fileImports = new Map<
      string,
      {
        relPath: string;
        specifiers: Array<{ specifier: string; names: string[]; edgeType?: "doc:references" }>;
      }
    >();
    fileImports.set(docPath, {
      relPath: docPath,
      specifiers: adapterResult.importSpecifiers,
    });

    // Run resolveImports
    store.transaction(() => {
      resolveImports(
        store,
        tmpDir,
        allRelPaths,
        fileImports as Parameters<typeof resolveImports>[3],
      );
    });

    // Verify: file_edges has a row doc→code with edge_type='doc:references'
    const edgeRow = db
      .prepare(
        `SELECT fe.edge_type FROM file_edges fe
         JOIN files src ON src.file_id = fe.source_file_id
         JOIN files tgt ON tgt.file_id = fe.target_file_id
         WHERE src.path = ? AND tgt.path = ?`,
      )
      .get(docPath, srcPath) as { edge_type: string } | undefined;

    expect(edgeRow).toBeDefined();
    expect(edgeRow?.edge_type).toBe("doc:references");

    // Silence unused variable warnings
    void srcFile;
    void docFile;
  });

  test("metric identity — in_degree of code file is identical with/without a doc citing it", () => {
    // Two .ts files: A imports B
    const fileAPath = "src/a.ts";
    const fileBPath = "src/b.ts";
    const docPath = "docs/map.md";

    const fileA = store.upsertFile({
      content_hash: "a",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: 1000,
      path: fileAPath,
    });
    const fileB = store.upsertFile({
      content_hash: "b",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: 1000,
      path: fileBPath,
    });

    // Insert the A→B imports edge
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "./b",
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });

    // Measure B's in_degree before adding doc edge
    const degreesBefore = query.getFileDegrees(fileB.file_id!);

    // Insert doc→B doc:references edge (simulating pipeline output)
    const docFile = store.upsertFile({
      content_hash: "doc",
      language: "markdown",
      last_indexed_at: Date.now(),
      layer: "docs",
      mtime_ms: 1000,
      path: docPath,
    });

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "doc:references",
      evidence: fileBPath,
      relation: null,
      source_file_id: docFile.file_id!,
      target_file_id: fileB.file_id!,
    });

    // Measure B's in_degree via the PINNED metric queries (edge_type='imports' only)
    // The stmtGetFileInDegree is pinned — it must NOT include the doc:references edge
    const degreesAfter = query.getFileDegrees(fileB.file_id!);

    expect(degreesAfter.in_degree).toBe(degreesBefore.in_degree);
    expect(degreesAfter.in_degree).toBe(1); // only the A→B imports edge

    // Also verify getAllFileDegrees is consistent
    const allDegrees = query.getAllFileDegrees();
    const bDegrees = allDegrees.get(fileB.file_id!);
    expect(bDegrees?.in_degree).toBe(1);

    void docFile;
  });
});
