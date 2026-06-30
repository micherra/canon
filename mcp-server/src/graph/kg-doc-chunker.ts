/**
 * kg-doc-chunker.ts
 *
 * Pure heading-section chunker for markdown documents.
 *
 * Strategy:
 * 1. Split the document on ATX heading lines (# / ## / ### etc.).
 * 2. Each heading introduces a new section; the `heading_path` is built as a
 *    breadcrumb trail from the document root: "H1 Title > H2 Section > H3 Sub".
 * 3. If a section body exceeds `maxChars`, it is split on paragraph boundaries
 *    first. Single paragraphs that are still too large are hard-cut at `maxChars`.
 * 4. Pre-heading content (before the first heading) is emitted as a chunk with
 *    an empty `heading_path`.
 *
 * This module is a pure function — no I/O, no SQLite, no EmbeddingService.
 */

import { DOC_CORPUS_MAX_CHUNK_CHARS } from "@shared/constants.ts";

export type RawChunk = {
  /** Breadcrumb trail, e.g. "H1 Title > H2 Section" or "" for pre-heading content. */
  heading_path: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
  content: string;
};

export type ChunkOptions = {
  /** Maximum characters per chunk (default: DOC_CORPUS_MAX_CHUNK_CHARS). */
  maxChars?: number;
};

// ATX heading pattern — lines starting with 1–6 `#` chars followed by a space
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

type SectionBoundary = { headingPath: string; bodyStart: number; bodyEnd: number };

/**
 * Pop stale trail entries and push the new heading; return the new breadcrumb path.
 * Extracted to keep buildSections' cognitive complexity below the limit.
 */
function updateHeadingTrail(
  trail: Array<{ level: number; title: string }>,
  level: number,
  title: string,
): string {
  while (trail.length > 0 && trail[trail.length - 1].level >= level) {
    trail.pop();
  }
  trail.push({ level, title });
  return trail.map((t) => t.title).join(" > ");
}

/**
 * Walk through `lines` and collect section boundaries.
 * A new section starts at each ATX heading line; pre-heading content is the first section.
 */
function buildSections(lines: string[]): SectionBoundary[] {
  const sections: SectionBoundary[] = [];
  const trail: Array<{ level: number; title: string }> = [];
  let sectionStart = 0;
  let currentHeadingPath = "";
  let charOffset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineEnd = charOffset + line.length + (lineIdx < lines.length - 1 ? 1 : 0);
    const m = HEADING_RE.exec(line);
    if (m) {
      if (charOffset > sectionStart) {
        sections.push({
          bodyEnd: charOffset,
          bodyStart: sectionStart,
          headingPath: currentHeadingPath,
        });
      }
      const level = m[1].length;
      const title = m[2].trim();
      currentHeadingPath = updateHeadingTrail(trail, level, title);
      sectionStart = charOffset;
    }
    charOffset = lineEnd;
  }
  if (charOffset > sectionStart) {
    sections.push({
      bodyEnd: charOffset,
      bodyStart: sectionStart,
      headingPath: currentHeadingPath,
    });
  }
  return sections;
}

/** Convert one section boundary into RawChunks, splitting large sections on paragraph boundaries. */
function sectionToChunks(
  section: SectionBoundary,
  content: string,
  maxChars: number,
  chunkOffset: number,
): RawChunk[] {
  const sectionContent = content.slice(section.bodyStart, section.bodyEnd);
  if (!sectionContent.trim()) return [];
  if (sectionContent.length <= maxChars) {
    return [
      {
        char_end: section.bodyEnd,
        char_start: section.bodyStart,
        chunk_index: chunkOffset,
        content: sectionContent,
        heading_path: section.headingPath,
      },
    ];
  }
  const paragraphs = splitOnParagraphs(sectionContent, section.bodyStart);
  return mergeIntoChunks(paragraphs, maxChars, section.headingPath, section.bodyStart).map(
    (sc, i) => ({ ...sc, chunk_index: chunkOffset + i }),
  );
}

/**
 * Split `content` into heading-section chunks, each at most `maxChars` chars.
 *
 * Returns an empty array for blank/whitespace-only input.
 */
export function chunkMarkdown(content: string, opts?: ChunkOptions): RawChunk[] {
  const maxChars = opts?.maxChars ?? DOC_CORPUS_MAX_CHUNK_CHARS;
  if (!content || content.trim().length === 0) return [];
  const lines = content.split("\n");
  const sections = buildSections(lines);
  const chunks: RawChunk[] = [];
  for (const section of sections) {
    const newChunks = sectionToChunks(section, content, maxChars, chunks.length);
    chunks.push(...newChunks);
  }
  return chunks;
}

type Paragraph = { text: string; absStart: number; absEnd: number };

/** Split a section body into paragraphs (separated by one or more blank lines). */
function splitOnParagraphs(sectionBody: string, absStart: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const paraRe = /\S[\s\S]*?(?=\n\s*\n|$)/g;

  for (;;) {
    const m = paraRe.exec(sectionBody);
    if (m === null) break;
    const text = m[0];
    paragraphs.push({
      absEnd: absStart + m.index + text.length,
      absStart: absStart + m.index,
      text,
    });
  }
  return paragraphs;
}

/**
 * Greedily merge paragraphs into sub-chunks that each fit within maxChars.
 * Hard-cuts any single paragraph that still exceeds maxChars.
 */
function mergeIntoChunks(
  paragraphs: Paragraph[],
  maxChars: number,
  headingPath: string,
  sectionAbsStart: number,
): Omit<RawChunk, "chunk_index">[] {
  const chunks: Omit<RawChunk, "chunk_index">[] = [];
  let current: string[] = [];
  let currentStart = paragraphs[0]?.absStart ?? sectionAbsStart;

  function flushCurrent(): void {
    if (current.length === 0) return;
    const text = current.join("\n\n");
    const absEnd = currentStart + text.length;
    chunks.push({
      char_end: absEnd,
      char_start: currentStart,
      content: text,
      heading_path: headingPath,
    });
    current = [];
  }

  for (const para of paragraphs) {
    // If the paragraph alone exceeds maxChars, hard-cut it
    if (para.text.length > maxChars) {
      flushCurrent();
      let offset = 0;
      while (offset < para.text.length) {
        const slice = para.text.slice(offset, offset + maxChars);
        chunks.push({
          char_end: para.absStart + offset + slice.length,
          char_start: para.absStart + offset,
          content: slice,
          heading_path: headingPath,
        });
        offset += maxChars;
      }
      currentStart = para.absEnd;
      continue;
    }

    const joined = [...current, para.text].join("\n\n");
    if (joined.length > maxChars && current.length > 0) {
      flushCurrent();
      currentStart = para.absStart;
    }

    if (current.length === 0) {
      currentStart = para.absStart;
    }
    current.push(para.text);
  }

  flushCurrent();
  return chunks;
}
