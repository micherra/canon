/**
 * ensure-doc-corpus-fresh.test.ts
 *
 * Tests for ensureDocCorpusFresh — the lazy content-hash freshness gate.
 * Mirrors ensure-graph-fresh.test.ts patterns.
 *
 * dc-05: unchanged corpus → skip re-ingest
 * dc-05: mutated file → re-ingest fires and marker re-stamped
 * dc-06: DOC_CORPUS_HASH_KEY marker stored in meta (not git HEAD)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDocCorpusFresh } from "@features/knowledge-graph/ensure-doc-corpus-fresh.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { DocCorpusSource } from "@shared/constants.ts";
import { DOC_CORPUS_HASH_KEY } from "@shared/constants.ts";
import { MockEmbeddingService } from "@tests/helpers/embedding-test-helpers.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock ingestDocCorpus so tests don't actually run the full ingest pipeline
vi.mock("@graph/kg-doc-ingest.ts", () => ({
  ingestDocCorpus: vi.fn().mockResolvedValue(undefined),
}));

import { ingestDocCorpus } from "@graph/kg-doc-ingest.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `ensure-doc-fresh-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeDbPath(): string {
  return join(tempDir, "knowledge-graph.db");
}

function makeSource(corpus: string, root: string): DocCorpusSource {
  return { corpus, root, trust_tier: "internal", optional: false };
}

function writeDoc(relPath: string, content = "# Doc\n\nContent."): void {
  const fullPath = join(tempDir, relPath);
  mkdirSync(fullPath.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(fullPath, content);
}

function seedDb(dbPath: string, hashMarker: string): void {
  const db = initDatabase(dbPath);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(
    DOC_CORPUS_HASH_KEY,
    hashMarker,
  );
  db.close();
}

describe("ensureDocCorpusFresh", () => {
  test("no-op when DB file does not exist", async () => {
    const dbPath = join(tempDir, "nonexistent.db");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];

    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());

    expect(ingestDocCorpus).not.toHaveBeenCalled();
  });

  test("dc-05: unchanged corpus → hash marker matches → no re-ingest", async () => {
    writeDoc("principles/p1.md");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();

    // Run once to establish the marker
    const db = initDatabase(dbPath);
    db.close();

    // Seed with the correct hash by running once
    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());
    expect(ingestDocCorpus).toHaveBeenCalledTimes(1);

    // Now the marker should be stamped — next call should be no-op
    vi.clearAllMocks();
    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());
    expect(ingestDocCorpus).not.toHaveBeenCalled();
  });

  test("dc-05: mutated file → hash changes → re-ingest fires", async () => {
    writeDoc("principles/p1.md", "# Original\n\nOriginal content.");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    // First run: stale (no marker) → ingest
    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());
    expect(ingestDocCorpus).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Mutate the file
    writeFileSync(join(tempDir, "principles/p1.md"), "# Modified\n\nChanged content.");

    // Second run: hash mismatch → re-ingest
    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());
    expect(ingestDocCorpus).toHaveBeenCalledTimes(1);
  });

  test("dc-06: marker stored in meta table under DOC_CORPUS_HASH_KEY", async () => {
    writeDoc("principles/p1.md");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();
    const db1 = initDatabase(dbPath);
    db1.close();

    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());

    const db2 = initDatabase(dbPath);
    const row = db2.prepare(`SELECT value FROM meta WHERE key = ?`).get(DOC_CORPUS_HASH_KEY) as
      | { value: string }
      | undefined;
    db2.close();

    expect(row).toBeDefined();
    expect(row!.value).toBeTruthy();
    // Marker must be a hex-looking string (sha256), not a git SHA
    expect(row!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stale marker (hash mismatch pre-seeded) → triggers re-ingest", async () => {
    writeDoc("principles/p1.md");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();

    // Seed a wrong hash
    seedDb(dbPath, "00000000000000000000000000000000000000000000000000000000deadbeef");

    await ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService());
    expect(ingestDocCorpus).toHaveBeenCalledTimes(1);
  });

  test("ingest error is swallowed — fail-open", async () => {
    writeDoc("principles/p1.md");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    (ingestDocCorpus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("embed failed"));

    await expect(
      ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService()),
    ).resolves.not.toThrow();
  });

  test("concurrent callers deduplicate — only one ingest runs per stale cycle", async () => {
    writeDoc("principles/p1.md");
    const sources: DocCorpusSource[] = [makeSource("principles", join(tempDir, "principles"))];
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    // Both fire concurrently
    await Promise.all([
      ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService()),
      ensureDocCorpusFresh(dbPath, sources, new MockEmbeddingService()),
    ]);

    expect(ingestDocCorpus).toHaveBeenCalledTimes(1);
  });
});
