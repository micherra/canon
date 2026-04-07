import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveProjectDir } from "../resolve-project-dir.ts";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

type ListRootsResult = { roots: Array<{ uri: string; name?: string }> };

/** Builds a minimal mock `Server` object with a controllable `listRoots`. */
const makeServer = (
  listRoots: (params?: unknown, options?: { signal?: AbortSignal }) => Promise<ListRootsResult>,
): Server => ({ listRoots } as unknown as Server);

describe("resolveProjectDir", () => {
  it("returns the path of the first file:// root from listRoots", async () => {
    const server = makeServer(async () => ({
      roots: [{ uri: "file:///home/user/myproject", name: "My Project" }],
    }));

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe(resolve("/home/user/myproject"));
  });

  it("returns fallback when listRoots returns no file:// roots", async () => {
    const server = makeServer(async () => ({
      roots: [{ uri: "vscode://settings", name: "Settings" }],
    }));

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe("/fallback");
  });

  it("returns fallback when listRoots returns an empty roots array", async () => {
    const server = makeServer(async () => ({ roots: [] }));
    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe("/fallback");
  });

  it("returns fallback and logs when listRoots times out, and aborts the in-flight request", async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // listRoots respects the abort signal: rejects when aborted.
    const server = makeServer(
      (_params, options) =>
        new Promise<ListRootsResult>((_res, rej) => {
          options?.signal?.addEventListener("abort", () => {
            rej(new DOMException("Aborted", "AbortError"));
          });
          // Never resolves on its own
        }),
    );

    const resultPromise = resolveProjectDir(server, "/fallback", 500);
    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    expect(result).toBe("/fallback");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("roots/list timed out"),
    );

    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns fallback when listRoots never resolves (no abort signal support)", async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // listRoots never resolves and ignores the abort signal
    const server = makeServer(() => new Promise<ListRootsResult>(() => {}));

    const resultPromise = resolveProjectDir(server, "/fallback", 500);
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    expect(result).toBe("/fallback");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("roots/list timed out"),
    );

    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns fallback when listRoots throws", async () => {
    const server = makeServer(async () => {
      throw new Error("not supported");
    });

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe("/fallback");
  });

  it("picks the first file:// root when multiple roots exist", async () => {
    const server = makeServer(async () => ({
      roots: [
        { uri: "file:///home/user/project-a" },
        { uri: "file:///home/user/project-b" },
      ],
    }));

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe(resolve("/home/user/project-a"));
  });

  it("skips non-file roots and uses first file:// root", async () => {
    const server = makeServer(async () => ({
      roots: [
        { uri: "vscode://settings" },
        { uri: "file:///home/user/real-project" },
      ],
    }));

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe(resolve("/home/user/real-project"));
  });

  it("applies resolve() to make paths absolute", async () => {
    // A path that is already absolute should be preserved
    const server = makeServer(async () => ({
      roots: [{ uri: "file:///absolute/path" }],
    }));

    const result = await resolveProjectDir(server, "/fallback");
    expect(result).toBe("/absolute/path");
  });

  it("clears timeout when listRoots resolves before deadline", async () => {
    vi.useFakeTimers();
    // Returns immediately
    const server = makeServer(async () => ({
      roots: [{ uri: "file:///home/user/project" }],
    }));

    const result = await resolveProjectDir(server, "/fallback", 1000);
    expect(result).toBe(resolve("/home/user/project"));
    // Timer should have been cleared — advancing time should not cause any side effects
    await vi.advanceTimersByTimeAsync(2000);

    vi.useRealTimers();
  });
});
