/**
 * Tests for reindexFile — overlay grammar loading (FINDING B fix).
 *
 * Before this fix, reindexFile called initParsers() without projectDir, so a
 * fresh server process reindexing an overlay-language file found no adapter.
 * After the fix, initParsers(projectDir) + registerOverlayAdapters() are called.
 *
 * Kept in a separate file from kg-pipeline.test.ts to stay within the 600-line
 * per-file limit enforced by the nursery lint rule.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reindexFile } from "@graph/kg-pipeline-reindex.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock EmbeddingService — not needed here, but reindexFile indirectly pulls
// the pipeline which has an embedding dep; mock to avoid model downloads.
vi.mock("@graph/kg-embedding.ts", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(384));
    }
    async embedOne(_text: string): Promise<Float32Array> {
      return new Float32Array(384);
    }
    dispose(): void {
      // no-op
    }
    get isLoaded(): boolean {
      return false;
    }
  },
}));

function makeTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "kg-reindex-overlay-test-"));
}

function writeFile(projectDir: string, relPath: string, content: string): void {
  const absPath = path.join(projectDir, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

const MINIMAL_NODE_KINDS = {
  callExpression: [],
  classBody: [],
  classDef: [],
  exportStatement: [],
  functionDef: [],
  importStatement: [],
  methodDef: [],
  variableDecl: [],
};

// FINDING B fix: reindexFile passes projectDir to initParsers

describe("reindexFile — overlay grammar loading (FINDING B)", () => {
  let projectDir: string;
  let db: Database.Database;

  beforeEach(() => {
    projectDir = makeTempProject();
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(projectDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  test("reindexFile passes projectDir to initParsers so overlay grammars are attempted", async () => {
    // Write an overlay config that references a nonexistent wasm.
    // The fail-open overlay loader will warn and skip it — but the IMPORTANT
    // thing is that it was ATTEMPTED (warning emitted), confirming that
    // initParsers(projectDir) was called rather than initParsers().
    mkdirSync(path.join(projectDir, ".canon", "kg-languages"), { recursive: true });
    mkdirSync(path.join(projectDir, ".canon", "grammars"), { recursive: true });

    const overlayId = `reindex-overlay-${Date.now()}`;
    writeFileSync(
      path.join(projectDir, ".canon", "kg-languages", `${overlayId}.json`),
      JSON.stringify({
        extensions: [`.${overlayId}`],
        grammarFile: `tree-sitter-${overlayId}.wasm`, // does NOT exist
        id: overlayId,
        nodeKinds: MINIMAL_NODE_KINDS,
      }),
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress
    });

    // A built-in file so reindexFile has something to process
    writeFile(projectDir, "src/main.ts", "export const x = 1;");
    await reindexFile(db, projectDir, "src/main.ts");

    // The missing-wasm warning confirms initParsers(projectDir) was called
    // (which in turn called loadOverlayGrammars → warned about missing wasm).
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    const overlayWarned = warnMessages.some((m) => m.includes(overlayId));
    expect(overlayWarned).toBe(true);
  });

  test("reindexFile on a built-in language file succeeds when overlay dir exists but wasm is absent", async () => {
    // Regression guard: overlay loading fails open — built-in files must still index.
    mkdirSync(path.join(projectDir, ".canon", "kg-languages"), { recursive: true });
    mkdirSync(path.join(projectDir, ".canon", "grammars"), { recursive: true });

    writeFileSync(
      path.join(projectDir, ".canon", "kg-languages", "bogus.json"),
      JSON.stringify({
        extensions: [".bogus"],
        grammarFile: "tree-sitter-bogus.wasm",
        id: "bogus-lang",
        nodeKinds: MINIMAL_NODE_KINDS,
      }),
      "utf8",
    );

    vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress overlay warn
    });

    writeFile(projectDir, "src/safe.ts", "export function safe() {}");
    const result = await reindexFile(db, projectDir, "src/safe.ts");

    expect(result.changed).toBe(true);
    expect(result.entitiesAfter).toBeGreaterThan(0);
  });
});
