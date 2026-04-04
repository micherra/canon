/**
 * utils.test.ts
 *
 * Tests for pure utility functions in ui/lib/utils.ts.
 */

import { describe, expect, it } from "vitest";
import { getSeverityColor, pluralize, splitFilePath } from "../lib/utils.ts";

// ---------------------------------------------------------------------------
// splitFilePath
// ---------------------------------------------------------------------------

describe("splitFilePath()", () => {
  it("returns empty dir and empty name for empty string", () => {
    expect(splitFilePath("")).toEqual({ dir: "", name: "" });
  });

  it("returns empty dir and full string as name for root-level file (no slash)", () => {
    expect(splitFilePath("file.ts")).toEqual({ dir: "", name: "file.ts" });
  });

  it("returns dir with trailing slash and file name for nested path", () => {
    expect(splitFilePath("src/lib/file.ts")).toEqual({ dir: "src/lib/", name: "file.ts" });
  });

  it("handles a single-level directory path", () => {
    expect(splitFilePath("src/file.ts")).toEqual({ dir: "src/", name: "file.ts" });
  });

  it("handles a path that ends with a slash (trailing slash edge case)", () => {
    const result = splitFilePath("src/lib/");
    // idx points to the last '/', so dir = 'src/lib/', name = ''
    expect(result).toEqual({ dir: "src/lib/", name: "" });
  });

  it("handles deeply nested path", () => {
    expect(splitFilePath("a/b/c/d.ts")).toEqual({ dir: "a/b/c/", name: "d.ts" });
  });

  it("handles root-level path with leading slash", () => {
    expect(splitFilePath("/foo.ts")).toEqual({ dir: "/", name: "foo.ts" });
  });

  it("returns falsy dir for bare filename (FilePath.svelte {#if parts.dir} guard)", () => {
    const result = splitFilePath("README.md");
    expect(Boolean(result.dir)).toBe(false);
  });

  it("returns truthy dir for nested path (FilePath.svelte dir-part will render)", () => {
    const result = splitFilePath("src/index.ts");
    expect(Boolean(result.dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pluralize
// ---------------------------------------------------------------------------

describe("pluralize()", () => {
  it("returns singular form when count is 1", () => {
    expect(pluralize(1, "file")).toBe("file");
  });

  it("returns default plural (singular + 's') when count is 0", () => {
    expect(pluralize(0, "file")).toBe("files");
  });

  it("returns default plural when count is > 1", () => {
    expect(pluralize(3, "file")).toBe("files");
  });

  it("returns custom plural when provided and count is not 1", () => {
    expect(pluralize(2, "entry", "entries")).toBe("entries");
  });

  it("returns singular even when custom plural is provided and count is 1", () => {
    expect(pluralize(1, "entry", "entries")).toBe("entry");
  });

  it("handles negative count (treated as plural)", () => {
    expect(pluralize(-1, "file")).toBe("files");
  });
});

// ---------------------------------------------------------------------------
// getSeverityColor
// ---------------------------------------------------------------------------

describe("getSeverityColor()", () => {
  it("returns correct color for 'rule' severity", () => {
    expect(getSeverityColor("rule")).toBe("#e74c3c");
  });

  it("returns correct color for 'strong-opinion' severity", () => {
    expect(getSeverityColor("strong-opinion")).toBe("#f39c12");
  });

  it("returns correct color for 'convention' severity", () => {
    expect(getSeverityColor("convention")).toBe("#3498db");
  });

  it("returns fallback '#636a80' for unknown severity", () => {
    expect(getSeverityColor("unknown-level")).toBe("#636a80");
  });

  it("returns fallback '#636a80' for empty string", () => {
    expect(getSeverityColor("")).toBe("#636a80");
  });
});
