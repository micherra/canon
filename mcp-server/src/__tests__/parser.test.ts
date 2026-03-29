import { describe, it, expect } from "vitest";
import { parseFrontmatter, parsePrinciple } from "../parser.ts";

describe("parseFrontmatter", () => {
  it("extracts top-level key-value pairs", () => {
    const content = `---
id: test-principle
title: Test Principle
severity: rule
---

Body content here.`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.id).toBe("test-principle");
    expect(frontmatter.title).toBe("Test Principle");
    expect(frontmatter.severity).toBe("rule");
    expect(body).toBe("Body content here.");
  });

  it("parses inline arrays", () => {
    const content = `---
id: test
tags: [security, validation]
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tags).toEqual(["security", "validation"]);
  });

  it("parses nested objects with inline and list-style arrays", () => {
    const content = `---
id: test
scope:
  layers: [api, ui]
  file_patterns:
    - "src/routes/**"
    - "**/*.controller.ts"
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    const scope = frontmatter.scope as Record<string, unknown>;
    expect(scope.layers).toEqual(["api", "ui"]);
    expect(scope.file_patterns).toEqual([
      "src/routes/**",
      "**/*.controller.ts",
    ]);
  });

  it("parses nested arrays with list items", () => {
    const content = `---
id: test
tags:
  - security
  - validation
  - testing
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tags).toEqual(["security", "validation", "testing"]);
  });

  it("returns empty frontmatter for files without YAML block", () => {
    const content = "Just plain markdown content.";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe("Just plain markdown content.");
  });

  it("strips quotes from values", () => {
    const content = `---
id: "quoted-id"
title: 'single-quoted'
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.id).toBe("quoted-id");
    expect(frontmatter.title).toBe("single-quoted");
  });

  it("handles empty inline arrays", () => {
    const content = `---
id: test
tags: []
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tags).toEqual([]);
  });
});

describe("parsePrinciple", () => {
  it("produces a complete Principle object", () => {
    const content = `---
id: validate-inputs
title: Validate at Trust Boundaries
severity: rule
scope:
  layers: [api]
  file_patterns:
    - "src/routes/**"
tags: [security, validation]
---

Always validate user input at API boundaries.

## Rationale

Prevents injection attacks.`;

    const p = parsePrinciple(content, "/path/to/file.md");
    expect(p.id).toBe("validate-inputs");
    expect(p.title).toBe("Validate at Trust Boundaries");
    expect(p.severity).toBe("rule");
    expect(p.scope.layers).toEqual(["api"]);
    expect(p.scope.file_patterns).toEqual(["src/routes/**"]);
    expect(p.tags).toEqual(["security", "validation"]);
    expect(p.archived).toBe(false);
    expect(p.filePath).toBe("/path/to/file.md");
    expect(p.body).toContain("Always validate user input");
    expect(p.body).toContain("## Rationale");
  });

  it("parses archived: true", () => {
    const content = `---
id: old-principle
title: Deprecated
severity: convention
archived: true
---

No longer relevant.`;

    const p = parsePrinciple(content, "test.md");
    expect(p.archived).toBe(true);
  });

  it("parses archived as string 'true'", () => {
    const content = `---
id: old-principle
title: Deprecated
severity: convention
archived: "true"
---

Body.`;

    const p = parsePrinciple(content, "test.md");
    expect(p.archived).toBe(true);
  });

  it("defaults severity to convention when missing", () => {
    const content = `---
id: no-severity
title: No Severity
---

Body.`;

    const p = parsePrinciple(content, "test.md");
    expect(p.severity).toBe("convention");
  });

  it("defaults scope to empty arrays", () => {
    const content = `---
id: no-scope
title: No Scope
severity: rule
---

Body.`;

    const p = parsePrinciple(content, "test.md");
    expect(p.scope.layers).toEqual([]);
    expect(p.scope.file_patterns).toEqual([]);
  });

  it("defaults tags to empty array", () => {
    const content = `---
id: no-tags
title: No Tags
severity: rule
---

Body.`;

    const p = parsePrinciple(content, "test.md");
    expect(p.tags).toEqual([]);
  });

  it("returns empty id for content without frontmatter", () => {
    const p = parsePrinciple("Just text", "test.md");
    expect(p.id).toBe("");
  });
});
