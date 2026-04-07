/**
 * Tests for resolveProjectDir — MCP roots priority chain for project directory resolution.
 *
 * Covers:
 * - Priority 1: CANON_PROJECT_DIR absolute path wins when set
 * - CANON_PROJECT_DIR relative path is ignored (falls through)
 * - CANON_PROJECT_DIR empty string is ignored (falls through)
 * - Priority 2: MCP roots first root URI used when CANON_PROJECT_DIR absent
 * - Priority 3: cwd fallback when roots list is empty
 * - Priority 3: cwd fallback when listRoots throws
 * - file:// URI is converted to filesystem path
 */

import { describe, expect, it, vi } from "vitest";
import { resolveProjectDir } from "../resolve-project-dir.ts";

describe("resolveProjectDir", () => {
  const cwd = "/fallback/cwd";

  it("uses CANON_PROJECT_DIR when it is an absolute path", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [] });
    const result = await resolveProjectDir("/absolute/project/dir", listRoots, cwd);
    expect(result).toBe("/absolute/project/dir");
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("ignores CANON_PROJECT_DIR when it is a relative path", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("./relative/path", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("ignores CANON_PROJECT_DIR when it is empty string", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("ignores CANON_PROJECT_DIR when undefined", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("parses file:// URI from MCP roots into a filesystem path", async () => {
    const listRoots = vi.fn().mockResolvedValue({
      roots: [{ uri: "file:///Users/alice/my-project", name: "my-project" }],
    });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/Users/alice/my-project");
  });

  it("uses cwd fallback when roots list is empty", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses cwd fallback when first root has no uri", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ name: "unnamed" }] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses cwd fallback when listRoots throws", async () => {
    const listRoots = vi.fn().mockRejectedValue(new Error("roots not supported"));
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses only the first root when multiple roots are present", async () => {
    const listRoots = vi.fn().mockResolvedValue({
      roots: [
        { uri: "file:///first/project" },
        { uri: "file:///second/project" },
      ],
    });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/first/project");
  });
});
