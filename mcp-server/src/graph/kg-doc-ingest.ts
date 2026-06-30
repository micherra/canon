/**
 * kg-doc-ingest.ts
 *
 * Ingests a set of markdown knowledge-corpus sources into the doc_chunks /
 * doc_vectors / doc_chunk_meta tables.
 *
 * Design:
 * - Strict phase separation: scan files (sync) → compute hashes (sync) →
 *   embed stale chunks (async) → write vectors (sync). Never embed inside
 *   a db.transaction().
 * - Fail-open at the source level: a missing optional (or non-optional) root
 *   directory is logged and skipped — never throws.
 * - Idempotent: re-running with an unchanged corpus is a cheap no-op (the
 *   getStaleChunks() call returns zero rows).
 */

import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkMarkdown } from "@graph/kg-doc-chunker.ts";
import { DocVectorStore } from "@graph/kg-doc-store.ts";
import type { EmbeddingServiceLike } from "@graph/kg-embedding.ts";
import type { DocCorpusSource } from "@shared/constants.ts";
import type Database from "better-sqlite3";

// Scan helpers

/** Safely stat a path, returning null on any error. */
function safeStatSync(abs: string): Stats | null {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/** Walk a directory tree, collecting absolute paths of all *.md files. */
function walkMarkdownDir(dir: string, results: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = safeStatSync(abs);
    if (!stat) continue;
    if (stat.isDirectory()) {
      walkMarkdownDir(abs, results);
    } else if (entry.endsWith(".md")) {
      results.push(abs);
    }
  }
}

/** Recursively collect all *.md files under `root`, returning absolute paths. */
function scanMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  walkMarkdownDir(root, results);
  return results;
}

// Per-file ingest

/**
 * Chunk and upsert one markdown file into the store.
 * Push docPath to seenDocPaths on success.
 * Fail-open: any error is caught and logged.
 */
function processOneFile(
  store: DocVectorStore,
  source: DocCorpusSource,
  absPath: string,
  seenDocPaths: string[],
): void {
  try {
    let fileContent: string;
    try {
      fileContent = readFileSync(absPath, "utf8");
    } catch (err) {
      console.warn(`[kg-doc-ingest] failed to read ${absPath}: ${String(err)}`);
      return;
    }

    const relPath = relative(source.root, absPath);
    const docPath = `${source.corpus}/${relPath}`;
    seenDocPaths.push(docPath);

    const rawChunks = chunkMarkdown(fileContent);
    if (rawChunks.length === 0) return;

    const keptIndexes: number[] = [];
    for (const raw of rawChunks) {
      const contentHash = DocVectorStore.textHash(raw.content);
      store.upsertDocChunk({
        char_end: raw.char_end,
        char_start: raw.char_start,
        chunk_index: raw.chunk_index,
        content: raw.content,
        content_hash: contentHash,
        corpus: source.corpus,
        doc_path: docPath,
        heading_path: raw.heading_path || null,
        trust_tier: source.trust_tier,
        updated_at: new Date().toISOString(),
      });
      keptIndexes.push(raw.chunk_index);
    }
    store.pruneDocChunks(source.corpus, docPath, keptIndexes);
  } catch (fileErr) {
    console.warn(`[kg-doc-ingest] error processing ${absPath}: ${String(fileErr)}`);
  }
}

// Per-source ingest

/**
 * Scan all .md files under one corpus source, chunk + upsert each, and prune stale docs.
 * Fail-open: missing roots and per-file errors are logged, never thrown.
 */
function processOneSource(store: DocVectorStore, source: DocCorpusSource): void {
  if (!existsSync(source.root)) {
    if (!source.optional) {
      console.warn(`[kg-doc-ingest] corpus root missing (non-optional): ${source.root}. Skipping.`);
    }
    return;
  }

  const files = scanMarkdownFiles(source.root);
  const seenDocPaths: string[] = [];
  for (const absPath of files) {
    processOneFile(store, source, absPath, seenDocPaths);
  }
  store.pruneCorpusDocs(source.corpus, seenDocPaths);
}

// Embed phase

/**
 * Batch-embed all stale doc chunks and write their vectors.
 * Fail-open: any error is caught and logged; never throws.
 */
async function embedStaleChunks(
  store: DocVectorStore,
  embedSvc: EmbeddingServiceLike,
): Promise<void> {
  try {
    const stale = store.getStaleChunks();
    if (stale.length === 0) {
      store.cleanOrphanDocVectors();
      return;
    }

    const texts = stale.map((c) => c.content);
    const embeddings = await embedSvc.embed(texts);

    for (let i = 0; i < stale.length; i++) {
      const chunk = stale[i];
      const embedding = embeddings[i];
      if (!embedding) continue;
      try {
        store.upsertDocVector(chunk.chunk_id, embedding, chunk.content_hash);
      } catch (vecErr) {
        console.warn(
          `[kg-doc-ingest] failed to write vector for chunk ${chunk.chunk_id}: ${String(vecErr)}`,
        );
      }
    }
  } catch (embedErr) {
    console.warn(`[kg-doc-ingest] embed phase failed: ${String(embedErr)}`);
  }

  // Always clean orphan doc_vectors at the end
  try {
    store.cleanOrphanDocVectors();
  } catch (cleanErr) {
    console.warn(`[kg-doc-ingest] orphan cleanup failed: ${String(cleanErr)}`);
  }
}

// Public entry point

/**
 * Ingest all markdown files from `sources` into the knowledge-corpus vector tables.
 *
 * For each source:
 * 1. Scan *.md files under the resolved root.
 * 2. Chunk each file into heading-section chunks (chunkMarkdown).
 * 3. Upsert chunk rows (idempotent via UNIQUE(corpus, doc_path, chunk_index)).
 * 4. Prune stale chunk rows for docs that disappeared or shrank.
 * 5. Embed stale chunks (async, outside any transaction).
 * 6. Write embedding vectors + meta (sync, inline-JSON workaround).
 * 7. Prune orphan doc_vectors rows.
 *
 * Errors from individual sources or individual files are caught and logged;
 * they never propagate — fail-open by design.
 */
export async function ingestDocCorpus(
  db: Database.Database,
  sources: DocCorpusSource[],
  embedSvc: EmbeddingServiceLike,
): Promise<void> {
  const store = new DocVectorStore(db);

  for (const source of sources) {
    try {
      processOneSource(store, source);
    } catch (sourceErr) {
      console.warn(
        `[kg-doc-ingest] error ingesting source "${source.corpus}": ${String(sourceErr)}`,
      );
    }
  }

  await embedStaleChunks(store, embedSvc);
}
