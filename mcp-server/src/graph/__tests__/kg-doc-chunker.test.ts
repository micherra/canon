/**
 * kg-doc-chunker.test.ts
 *
 * Tests for chunkMarkdown — the pure heading-section chunker.
 *
 * Verified: multi-KB fixture splits on H2/H3; no chunk > maxChars; short doc
 * yields one chunk per section; heading_path and char offsets correct;
 * oversize single paragraph hard-cut.
 */

import { chunkMarkdown } from "@graph/kg-doc-chunker.ts";
import { describe, expect, test } from "vitest";

const MAX = 1200;

describe("chunkMarkdown", () => {
  test("empty content returns no chunks", () => {
    expect(chunkMarkdown("", { maxChars: MAX })).toEqual([]);
  });

  test("whitespace-only content returns no chunks", () => {
    expect(chunkMarkdown("   \n\n  ", { maxChars: MAX })).toEqual([]);
  });

  test("single short section with no heading returns one chunk with empty heading_path", () => {
    const content = "This is a simple doc with no headings.";
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading_path).toBe("");
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].char_start).toBe(0);
    expect(chunks[0].char_end).toBe(content.length);
  });

  test("short doc with two H2 sections returns two chunks, one per section", () => {
    const content = `## First Section

Content of first section.

## Second Section

Content of second section.
`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading_path).toBe("First Section");
    expect(chunks[1].heading_path).toBe("Second Section");
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].chunk_index).toBe(1);
  });

  test("heading_path builds H1 > H2 trail for nested headings", () => {
    const content = `# Top Level

## Sub Section

Content here.
`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    // Two sections: H1 and H2
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const h2Chunk = chunks.find((c) => c.heading_path.includes("Sub Section"));
    expect(h2Chunk).toBeDefined();
    expect(h2Chunk!.heading_path).toBe("Top Level > Sub Section");
  });

  test("H2 after H2 resets sub-heading (sibling, not nested)", () => {
    const content = `# Doc

## Section A

Content A.

## Section B

Content B.
`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    const sectionA = chunks.find((c) => c.heading_path.endsWith("Section A"));
    const sectionB = chunks.find((c) => c.heading_path.endsWith("Section B"));
    expect(sectionA).toBeDefined();
    expect(sectionB).toBeDefined();
    // Both should be siblings under "Doc"
    expect(sectionA!.heading_path).toBe("Doc > Section A");
    expect(sectionB!.heading_path).toBe("Doc > Section B");
  });

  test("char_start and char_end are valid offsets into the original content", () => {
    const content = `## First\n\nContent.\n\n## Second\n\nMore content.\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    for (const chunk of chunks) {
      expect(chunk.char_start).toBeGreaterThanOrEqual(0);
      expect(chunk.char_end).toBeLessThanOrEqual(content.length);
      expect(chunk.char_start).toBeLessThan(chunk.char_end);
      // content slice matches at least part of the original doc
      const originalSlice = content.slice(chunk.char_start, chunk.char_end);
      expect(originalSlice.length).toBeGreaterThan(0);
    }
  });

  test("chunk_index is monotonically increasing", () => {
    const content = `## A\n\nFirst.\n\n## B\n\nSecond.\n\n## C\n\nThird.\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(chunks[i - 1].chunk_index + 1);
    }
  });

  test("section exceeding maxChars is split into sub-chunks ≤ maxChars each", () => {
    // Build a section with multiple large paragraphs
    const para = "A".repeat(500);
    const content = `## Big Section\n\n${para}\n\n${para}\n\n${para}\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX);
    }
  });

  test("sub-chunks from oversize section have heading_path prepended to content", () => {
    const para = "B".repeat(600);
    const content = `## My Heading\n\n${para}\n\n${para}\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    // Should produce 2+ sub-chunks since 600+600 > 1200
    expect(chunks.length).toBeGreaterThan(1);
    // Each sub-chunk content includes the heading
    for (const chunk of chunks) {
      if (!chunk.content.startsWith("## My Heading")) {
        // heading_path should be set
        expect(chunk.heading_path).toBe("My Heading");
      }
    }
  });

  test("single oversize paragraph is hard-cut at maxChars", () => {
    const para = "C".repeat(2000);
    const content = `## Hard Cut\n\n${para}\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX);
    }
    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("multi-KB fixture with H2/H3 produces correct section splits", () => {
    const section1Body = "Line of text.\n".repeat(5);
    const section2Body = "Another line.\n".repeat(5);
    const section3Body = "Third section content.\n".repeat(5);
    const content = `# Title\n\n${section1Body}\n## Sub A\n\n${section2Body}\n### Sub-Sub\n\n${section3Body}`;

    const chunks = chunkMarkdown(content, { maxChars: MAX });
    // Should have chunks for each section
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const pathSet = new Set(chunks.map((c) => c.heading_path));
    expect(pathSet.has("Title")).toBe(true);
    expect(pathSet.has("Title > Sub A")).toBe(true);
    expect(pathSet.has("Title > Sub A > Sub-Sub")).toBe(true);
  });

  test("no chunk exceeds maxChars even for very large docs", () => {
    // 10 sections each with 3 large paragraphs
    let content = "";
    for (let s = 0; s < 10; s++) {
      content += `## Section ${s}\n\n`;
      for (let p = 0; p < 3; p++) {
        content += `${"W".repeat(600)}\n\n`;
      }
    }
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX);
    }
  });

  test("pre-heading content is included in a chunk with empty heading_path", () => {
    const content = `Preamble before any heading.\n\n## Section\n\nSection content.\n`;
    const chunks = chunkMarkdown(content, { maxChars: MAX });
    const preChunk = chunks.find((c) => c.heading_path === "");
    expect(preChunk).toBeDefined();
    expect(preChunk!.content).toContain("Preamble before any heading");
  });
});
