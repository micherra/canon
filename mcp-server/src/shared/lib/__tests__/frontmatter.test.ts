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
});
