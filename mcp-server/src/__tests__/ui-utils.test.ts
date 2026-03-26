/**
 * ui-utils.test.ts
 *
 * Unit tests for pure utility functions used by UI components.
 *
 * Covers:
 *   - splitFilePath: used by FilePath.svelte to split a path into dir + name parts
 *
 * Note: Svelte component files (EmptyState, FilePath, Badge) and
 * useDataLoader.svelte.ts (which uses $state runes) require the Svelte
 * compiler transform pipeline and cannot be tested in this Node/vitest
 * environment without @testing-library/svelte + jsdom. Those components
 * are covered by the plan's behavioral contract verification (render
 * output matches spec).
 */

import { describe, it, expect } from "vitest";
import { splitFilePath } from "../../ui/lib/utils";

describe("splitFilePath", () => {
  it("splits a normal nested path into dir and name", () => {
    const result = splitFilePath("src/tools/update-board.ts");
    expect(result.dir).toBe("src/tools/");
    expect(result.name).toBe("update-board.ts");
  });

  it("splits a deeply nested path correctly", () => {
    const result = splitFilePath("mcp-server/ui/components/ViolationCard.svelte");
    expect(result.dir).toBe("mcp-server/ui/components/");
    expect(result.name).toBe("ViolationCard.svelte");
  });

  it("returns empty dir and full path as name for a bare filename", () => {
    const result = splitFilePath("index.ts");
    expect(result.dir).toBe("");
    expect(result.name).toBe("index.ts");
  });

  it("handles root-level path (single slash)", () => {
    const result = splitFilePath("/foo.ts");
    expect(result.dir).toBe("/");
    expect(result.name).toBe("foo.ts");
  });

  it("handles trailing slash (empty filename)", () => {
    const result = splitFilePath("src/tools/");
    expect(result.dir).toBe("src/tools/");
    expect(result.name).toBe("");
  });

  it("splits a path with only one directory segment", () => {
    const result = splitFilePath("ui/App.svelte");
    expect(result.dir).toBe("ui/");
    expect(result.name).toBe("App.svelte");
  });

  it("returns consistent results used by FilePath.svelte — no dir, full name for flat file", () => {
    // FilePath renders {#if parts.dir} conditionally, so empty dir must be falsy
    const result = splitFilePath("README.md");
    expect(result.dir).toBe("");
    expect(Boolean(result.dir)).toBe(false);
    expect(result.name).toBe("README.md");
  });

  it("returns truthy dir for nested paths — FilePath.svelte dir-part will render", () => {
    const result = splitFilePath("src/index.ts");
    expect(Boolean(result.dir)).toBe(true);
    expect(result.dir).toBe("src/");
  });
});
