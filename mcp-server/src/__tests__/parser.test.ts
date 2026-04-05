import { describe, expect, it } from "vitest";
import {
  extractSections,
  filterBodyBySections,
  parseFrontmatter,
  parsePrinciple,
} from "../shared/parser.ts";

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
    expect(scope.file_patterns).toEqual(["src/routes/**", "**/*.controller.ts"]);
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

describe("extractSections", () => {
  it("returns empty map and full body when no ## sections exist", () => {
    const body = "Just a summary paragraph.\n\nAnother paragraph.";
    const { sections, remainder } = extractSections(body);
    expect(sections.size).toBe(0);
    expect(remainder).toBe(body);
  });

  it("extracts Anti-Rationalization section and leaves unknown sections in remainder", () => {
    const body =
      "Summary paragraph.\n\n## Rationale\n\nThe rationale.\n\n## Anti-Rationalization\n\nThe table.";
    const { sections, remainder } = extractSections(body);
    expect(sections.has("Anti-Rationalization")).toBe(true);
    expect(sections.get("Anti-Rationalization")).toContain("The table.");
    expect(remainder).toContain("Summary paragraph.");
    expect(remainder).toContain("## Rationale");
    expect(remainder).not.toContain("## Anti-Rationalization");
  });

  it("extracts Verification section", () => {
    const body = "Summary.\n\n## Verification\n\nRun the check.";
    const { sections, remainder } = extractSections(body);
    expect(sections.has("Verification")).toBe(true);
    expect(sections.get("Verification")).toContain("Run the check.");
    expect(remainder).not.toContain("## Verification");
  });

  it("extracts both Anti-Rationalization and Verification simultaneously", () => {
    const body =
      "Summary.\n\n## Anti-Rationalization\n\nExcuses table.\n\n## Verification\n\nShell commands.";
    const { sections, remainder } = extractSections(body);
    expect(sections.has("Anti-Rationalization")).toBe(true);
    expect(sections.has("Verification")).toBe(true);
    expect(sections.get("Anti-Rationalization")).toContain("Excuses table.");
    expect(sections.get("Verification")).toContain("Shell commands.");
    expect(remainder.trim()).toBe("Summary.");
  });

  it("is case-insensitive on heading match", () => {
    const body = "Summary.\n\n## anti-rationalization\n\nContent.";
    const { sections } = extractSections(body);
    expect(sections.has("Anti-Rationalization")).toBe(true);
  });

  it("preserves unknown sections like Rationale and Examples in remainder", () => {
    const body =
      "Summary.\n\n## Rationale\n\nWhy.\n\n## Examples\n\nHow.\n\n## Anti-Rationalization\n\nTable.";
    const { sections, remainder } = extractSections(body);
    expect(remainder).toContain("## Rationale");
    expect(remainder).toContain("## Examples");
    expect(remainder).not.toContain("## Anti-Rationalization");
    expect(sections.size).toBe(1);
  });
});

describe("parsePrinciple with section extraction", () => {
  it("populates anti_rationalization field when section present", () => {
    const content = `---
id: test
title: Test
severity: rule
---

Summary paragraph.

## Anti-Rationalization

The excuse table.`;
    const p = parsePrinciple(content, "test.md");
    expect(p.anti_rationalization).toContain("The excuse table.");
  });

  it("populates verification field when section present", () => {
    const content = `---
id: test
title: Test
severity: rule
---

Summary paragraph.

## Verification

\`\`\`bash
npm test
\`\`\``;
    const p = parsePrinciple(content, "test.md");
    expect(p.verification).toContain("npm test");
  });

  it("leaves fields undefined when sections absent", () => {
    const content = `---
id: test
title: Test
severity: rule
---

Summary paragraph.

## Rationale

Some rationale.`;
    const p = parsePrinciple(content, "test.md");
    expect(p.anti_rationalization).toBeUndefined();
    expect(p.verification).toBeUndefined();
  });

  it("body field contains remainder without extracted sections", () => {
    const content = `---
id: test
title: Test
severity: rule
---

Summary paragraph.

## Rationale

Rationale text.

## Anti-Rationalization

Table content.`;
    const p = parsePrinciple(content, "test.md");
    expect(p.body).toContain("## Rationale");
    expect(p.body).not.toContain("## Anti-Rationalization");
  });
});

describe("filterBodyBySections", () => {
  const summaryParagraph = "Summary paragraph.";
  const body = `${summaryParagraph}\n\n## Rationale\n\nRationale text.`;
  const antiRat = "Excuse table.";
  const verification = "Shell commands.";

  it("returns summary + requested section only when sections list provided", () => {
    const result = filterBodyBySections(body, antiRat, verification, [
      "anti_rationalization",
    ]);
    expect(result).toContain(summaryParagraph);
    expect(result).toContain("## Anti-Rationalization");
    expect(result).toContain(antiRat);
    expect(result).not.toContain("## Verification");
    expect(result).not.toContain(verification);
  });

  it("returns full body when sections list is empty", () => {
    const result = filterBodyBySections(body, antiRat, verification, []);
    expect(result).toContain(summaryParagraph);
    expect(result).toContain("## Rationale");
    expect(result).toContain("## Anti-Rationalization");
    expect(result).toContain("## Verification");
  });
});
