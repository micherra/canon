/**
 * kg-doc-ingest.test.ts
 *
 * Tests for ingestDocCorpus:
 * - dc-01: fixture corpus dir → N chunks persisted per .md file
 * - dc-02: re-run on unchanged corpus is no-op (idempotent)
 * - removed file's chunks are pruned on re-run
 * - optional source absent → fail-open (no error)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDocCorpus } from "@graph/kg-doc-ingest.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { DocCorpusSource } from "@shared/constants.ts";
import { MockEmbeddingService } from "@tests/helpers/embedding-test-helpers.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `kg-doc-ingest-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeDoc(relPath: string, content: string): void {
  const fullPath = join(tempDir, relPath);
  mkdirSync(join(tempDir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(fullPath, content);
}

function makeSource(corpus: string, relRoot: string): DocCorpusSource {
  return {
    corpus,
    root: join(tempDir, relRoot),
    trust_tier: "internal",
    optional: false,
  };
}

describe("ingestDocCorpus", () => {
  test("dc-01: fixture corpus with 3 docs produces at least 3 doc_chunks rows", async () => {
    writeDoc("principles/p1.md", "# Principle One\n\nContent of principle one.");
    writeDoc("principles/p2.md", "# Principle Two\n\nContent of principle two.");
    writeDoc("principles/p3.md", "# Principle Three\n\nContent of principle three.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("principles", "principles")];

    await ingestDocCorpus(db, sources, embedSvc);

    const count = (
      db.prepare(`SELECT COUNT(*) as c FROM doc_chunks WHERE corpus = 'principles'`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBeGreaterThanOrEqual(3);

    db.close();
  });

  test("dc-01: each ingested .md file has at least one chunk", async () => {
    writeDoc("principles/one.md", "Short one-liner principle.");
    writeDoc("principles/two.md", "Short two-liner principle.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("principles", "principles")];

    await ingestDocCorpus(db, sources, embedSvc);

    const rows = db
      .prepare(
        `SELECT DISTINCT doc_path FROM doc_chunks WHERE corpus = 'principles' ORDER BY doc_path`,
      )
      .all() as { doc_path: string }[];
    const docPaths = rows.map((r) => r.doc_path);
    expect(docPaths.some((p) => p.includes("one.md"))).toBe(true);
    expect(docPaths.some((p) => p.includes("two.md"))).toBe(true);

    db.close();
  });

  test("dc-02: re-run on unchanged corpus is no-op (row count stable)", async () => {
    writeDoc("docs/guide.md", "## Section\n\nSome stable content here.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("docs", "docs")];

    await ingestDocCorpus(db, sources, embedSvc);
    const countAfterFirst = (
      db.prepare(`SELECT COUNT(*) as c FROM doc_chunks`).get() as { c: number }
    ).c;

    // Second run — corpus unchanged
    await ingestDocCorpus(db, sources, embedSvc);
    const countAfterSecond = (
      db.prepare(`SELECT COUNT(*) as c FROM doc_chunks`).get() as { c: number }
    ).c;

    expect(countAfterSecond).toBe(countAfterFirst);
    db.close();
  });

  test("removed file's chunks are pruned on re-ingest", async () => {
    writeDoc("docs/keep.md", "# Keep\n\nThis doc stays.");
    writeDoc("docs/remove.md", "# Remove\n\nThis doc will be deleted.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("docs", "docs")];

    await ingestDocCorpus(db, sources, embedSvc);

    const beforeCount = (db.prepare(`SELECT COUNT(*) as c FROM doc_chunks`).get() as { c: number })
      .c;
    expect(beforeCount).toBeGreaterThanOrEqual(2);

    // Delete one doc and re-ingest
    rmSync(join(tempDir, "docs/remove.md"));
    await ingestDocCorpus(db, sources, embedSvc);

    const removedChunks = db
      .prepare(`SELECT * FROM doc_chunks WHERE doc_path LIKE '%remove%'`)
      .all();
    expect(removedChunks).toHaveLength(0);

    const keepChunks = db.prepare(`SELECT * FROM doc_chunks WHERE doc_path LIKE '%keep%'`).all();
    expect(keepChunks.length).toBeGreaterThan(0);
    db.close();
  });

  test("optional source absent → fail-open (no error thrown)", async () => {
    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [
      {
        corpus: "digest",
        root: join(tempDir, "nonexistent-memory"),
        trust_tier: "internal",
        optional: true,
      },
    ];

    await expect(ingestDocCorpus(db, sources, embedSvc)).resolves.not.toThrow();
    db.close();
  });

  test("non-optional source absent → still fails open (logs warning, no throw)", async () => {
    // Per design: ingestDocCorpus is fail-open for all sources at the file-scan level
    // Missing corpus root → skip with warning, never throw
    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [
      {
        corpus: "principles",
        root: join(tempDir, "absolutely-does-not-exist"),
        trust_tier: "internal",
        optional: false,
      },
    ];

    await expect(ingestDocCorpus(db, sources, embedSvc)).resolves.not.toThrow();
    db.close();
  });

  test("chunks have correct trust_tier from source descriptor", async () => {
    writeDoc("ext/doc.md", "# External\n\nContent.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [
      {
        corpus: "external",
        root: join(tempDir, "ext"),
        trust_tier: "external",
        optional: false,
      },
    ];

    await ingestDocCorpus(db, sources, embedSvc);

    const row = db
      .prepare(`SELECT trust_tier FROM doc_chunks WHERE corpus = 'external' LIMIT 1`)
      .get() as { trust_tier: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.trust_tier).toBe("external");
    db.close();
  });

  test("two sources with different corpora produce rows in both corpus buckets", async () => {
    writeDoc("principles/rule.md", "# Rule\n\nDo good.");
    writeDoc("references/ref.md", "# Reference\n\nSee here.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [
      makeSource("principles", "principles"),
      makeSource("references", "references"),
    ];

    await ingestDocCorpus(db, sources, embedSvc);

    const corpora = db.prepare(`SELECT DISTINCT corpus FROM doc_chunks ORDER BY corpus`).all() as {
      corpus: string;
    }[];
    const corpusSet = new Set(corpora.map((c) => c.corpus));
    expect(corpusSet.has("principles")).toBe(true);
    expect(corpusSet.has("references")).toBe(true);
    db.close();
  });

  // Sad path (a): absent optional source fails open AND other corpora still indexed
  test("sad-path(a): absent optional source does not prevent other corpora from being indexed", async () => {
    writeDoc("principles/rule.md", "# Rule\n\nContent.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [
      // This one is present — must still be indexed
      makeSource("principles", "principles"),
      // This one is absent (optional) — must fail open silently
      {
        corpus: "digest",
        root: join(tempDir, "nonexistent-memory"),
        trust_tier: "internal",
        optional: true,
      },
    ];

    await expect(ingestDocCorpus(db, sources, embedSvc)).resolves.not.toThrow();

    // The present source must still be indexed despite the absent optional one
    const count = (
      db.prepare(`SELECT COUNT(*) as c FROM doc_chunks WHERE corpus = 'principles'`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBeGreaterThanOrEqual(1);

    // The absent source must produce zero rows
    const digestCount = (
      db.prepare(`SELECT COUNT(*) as c FROM doc_chunks WHERE corpus = 'digest'`).get() as {
        c: number;
      }
    ).c;
    expect(digestCount).toBe(0);

    db.close();
  });

  // Sad path (d): zero stale chunks → embed() is never called (model load skipped)
  test("sad-path(d): unchanged corpus on re-run does not call embed (zero stale → model load skipped)", async () => {
    writeDoc("principles/stable.md", "## Stable Section\n\nContent that will not change.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("principles", "principles")];

    // First run: corpus is fresh → stale chunks exist → embed IS called
    const embedSpyFirst = vi.spyOn(embedSvc, "embed");
    await ingestDocCorpus(db, sources, embedSvc);
    expect(embedSpyFirst).toHaveBeenCalledTimes(1);
    embedSpyFirst.mockRestore();

    // Second run: corpus unchanged → zero stale chunks → embed must NOT be called
    const embedSpySecond = vi.spyOn(embedSvc, "embed");
    await ingestDocCorpus(db, sources, embedSvc);
    expect(embedSpySecond).not.toHaveBeenCalled();
    embedSpySecond.mockRestore();

    db.close();
  });

  // Sad path (e): empty markdown file at ingest level does not crash
  test("sad-path(e): empty markdown file produces zero chunks and does not crash", async () => {
    // Write an empty file alongside a valid one
    writeDoc("principles/empty.md", "");
    writeDoc("principles/valid.md", "# Valid\n\nHas real content.");

    const db = initDatabase(":memory:");
    const embedSvc = new MockEmbeddingService();
    const sources: DocCorpusSource[] = [makeSource("principles", "principles")];

    await expect(ingestDocCorpus(db, sources, embedSvc)).resolves.not.toThrow();

    // Empty file must produce zero doc_chunks rows
    const emptyChunks = db.prepare(`SELECT * FROM doc_chunks WHERE doc_path LIKE '%empty%'`).all();
    expect(emptyChunks).toHaveLength(0);

    // Valid file must still produce at least one chunk
    const validChunks = db.prepare(`SELECT * FROM doc_chunks WHERE doc_path LIKE '%valid%'`).all();
    expect(validChunks.length).toBeGreaterThan(0);

    db.close();
  });
});
