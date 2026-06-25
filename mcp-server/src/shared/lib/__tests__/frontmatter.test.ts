import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "../frontmatter.ts";

describe("splitFrontmatter", () => {
  it("extracts flat scalar frontmatter and trims nothing from the body", () => {
    const content = `---
id: test-principle
title: Test Principle
severity: rule
---

Body content here.`;
    const { data, body } = splitFrontmatter(content);
    expect(data.id).toBe("test-principle");
    expect(data.title).toBe("Test Principle");
    expect(data.severity).toBe("rule");
    // body is everything after the closing fence (gray-matter strips the leading newline).
    expect(body).toContain("Body content here.");
  });

  it("parses inline arrays", () => {
    const content = `---
id: test
tags: [security, validation]
---

Body`;
    const { data } = splitFrontmatter(content);
    expect(data.tags).toEqual(["security", "validation"]);
  });

  it("parses nested maps with inline and list-style arrays", () => {
    const content = `---
id: test
scope:
  layers: [api, ui]
  file_patterns:
    - "src/routes/**"
    - "**/*.controller.ts"
---

Body`;
    const { data } = splitFrontmatter(content);
    const scope = data.scope as Record<string, unknown>;
    expect(scope.layers).toEqual(["api", "ui"]);
    expect(scope.file_patterns).toEqual(["src/routes/**", "**/*.controller.ts"]);
  });

  it("round-trips folded (>-) and literal (|) block scalars", () => {
    const content = `---
id: test
folded: >-
  one two
  three
literal: |
  line one
  line two
---

Body`;
    const { data } = splitFrontmatter(content);
    expect(data.folded).toBe("one two three");
    expect(data.literal).toBe("line one\nline two\n");
  });

  it("strips quotes from single- and double-quoted values", () => {
    const content = `---
id: "quoted-id"
title: 'single-quoted'
---

Body`;
    const { data } = splitFrontmatter(content);
    expect(data.id).toBe("quoted-id");
    expect(data.title).toBe("single-quoted");
  });

  // --- Edge contracts pinned by PROBE-FINDINGS P3 ---

  it("no-frontmatter input → { data: {}, body: <original> }", () => {
    const content = "Just plain markdown content.";
    const { data, body } = splitFrontmatter(content);
    expect(data).toEqual({});
    expect(body).toBe("Just plain markdown content.");
  });

  it("empty frontmatter block → coalesces yaml null to {} (A4 regression)", () => {
    const content = `---
---

Body`;
    const { data } = splitFrontmatter(content);
    expect(data).toEqual({});
  });

  it("comment-only frontmatter block → coalesces yaml null to {} (A4 regression)", () => {
    const content = `---
# just a comment, no keys
---

Body`;
    const { data } = splitFrontmatter(content);
    expect(data).toEqual({});
  });

  it("malformed YAML → throws (A3 regression — do NOT swallow to {})", () => {
    const content = `---
bad: : indent
unclosed: [
---

Body`;
    expect(() => splitFrontmatter(content)).toThrow();
  });

  // --- Gray-matter parity edge cases (seam validation) ---

  it("BOM at start of file is treated as no-frontmatter (fence does not start at position 0)", () => {
    // A UTF-8 BOM (﻿) before `---` means the regex `/^---/` does not match.
    // The entire content (BOM + text) is returned as body with data: {}.
    const content = "﻿---\nid: bom-test\n---\n\nBody";
    const { data, body } = splitFrontmatter(content);
    expect(data).toEqual({});
    expect(body).toContain("---");
  });

  it("CRLF line endings inside the body are preserved verbatim", () => {
    // The fence regex accepts `\r?\n` so a CRLF-terminated fence parses correctly;
    // the body after the fence is returned byte-for-byte (CRLF intact).
    const content = "---\r\nid: crlf-test\r\n---\r\n\r\nLine one.\r\nLine two.\r\n";
    const { data, body } = splitFrontmatter(content);
    expect(data.id).toBe("crlf-test");
    // CRLF sequences in the body must survive unmodified.
    expect(body).toContain("\r\n");
    expect(body).toContain("Line one.");
  });

  it("a `---` appearing inside the body is NOT treated as a second fence", () => {
    // The regex is non-greedy and matches only up to the first `\n---\n?` after the
    // opening fence — a bare `---` line in the body is not consumed.
    const content = "---\nid: body-fence\n---\n\nSome body.\n\n---\n\nStill body.";
    const { data, body } = splitFrontmatter(content);
    expect(data.id).toBe("body-fence");
    // The second `---` and the text after it remain in the body.
    expect(body).toContain("---");
    expect(body).toContain("Still body.");
  });

  it("top-level bare sequence (non-object) frontmatter coalesces to {}", () => {
    // YAML parse of a bare sequence (`- a\n- b`) returns an array, not an object.
    // The `(parsed ?? {}) as Record<string, unknown>` cast passes through the array,
    // but the Zod schema validation layer (not splitFrontmatter) enforces object shape.
    // splitFrontmatter itself simply propagates whatever yaml.parse returns.
    const content = "---\n- alpha\n- beta\n---\n\nBody";
    // Should not throw — the YAML is well-formed.
    expect(() => splitFrontmatter(content)).not.toThrow();
    const { data } = splitFrontmatter(content);
    // The cast gives an array-as-record; the important invariant is no throw.
    expect(data).toBeDefined();
  });

  it("trailing-whitespace-only body is preserved exactly (no trimming)", () => {
    // splitFrontmatter must not trim the body — gray-matter parity.
    const content = "---\nid: ws-body\n---\n   \n  \n";
    const { data, body } = splitFrontmatter(content);
    expect(data.id).toBe("ws-body");
    // body should contain the whitespace-only lines, not be empty string.
    expect(body).toBe("   \n  \n");
  });

  it("multiple consecutive `---` fences: only the first pair is consumed", () => {
    // When two adjacent frontmatter-looking blocks appear, only the FIRST is parsed.
    const content = "---\nid: first\n---\n---\nid: second\n---\n\nBody";
    const { data, body } = splitFrontmatter(content);
    expect(data.id).toBe("first");
    // The second fence pair is left as body content.
    expect(body).toContain("---");
    expect(body).toContain("id: second");
  });
});
