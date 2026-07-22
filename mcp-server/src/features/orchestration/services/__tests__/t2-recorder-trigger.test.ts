/**
 * t2-recorder-trigger.test.ts — unit tests for the T2 recorder fire-and-
 * forget trigger (ADR-0065).
 *
 * The mandatory AC-5 proof (never-break-a-build, structural not
 * conventional) lives here: an injected spawnFn that throws synchronously
 * must never escape triggerT2Recorder — no throw, no uncaughtException,
 * just a `false` return. All spawns are injected (never a real `npx tsx`
 * process), so these tests are fast and hermetic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "@platform/adapters/process-adapter.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerT2Recorder } from "../t2-recorder-trigger.ts";

/** Minimal ChildProcess-shaped fake — only `.on` and `.unref` are used. */
function fakeChild() {
  return {
    on: vi.fn().mockReturnThis(),
    unref: vi.fn(),
  };
}

describe("triggerT2Recorder", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "t2-trigger-test-"));
  });

  afterEach(() => {
    rmSync(worktree, { force: true, recursive: true });
  });

  it("returns false without throwing when the injected spawnFn throws synchronously (AC-5)", () => {
    const throwingSpawn: SpawnFn = vi.fn(() => {
      throw new Error("ENOENT: spawn npx");
    });

    let result: boolean | undefined;
    expect(() => {
      result = triggerT2Recorder(
        { base: "abc123", projectDir: "/tmp/project", slug: "test-slug", worktree },
        throwingSpawn,
      );
    }).not.toThrow();

    expect(result).toBe(false);
    expect(throwingSpawn).toHaveBeenCalledTimes(1);
  });

  it("returns false and never calls spawnFn when worktree does not exist", () => {
    const spawnFn = vi.fn<SpawnFn>();
    const result = triggerT2Recorder(
      {
        base: "abc123",
        projectDir: "/tmp/project",
        slug: "test-slug",
        worktree: join(worktree, "does-not-exist"),
      },
      spawnFn,
    );

    expect(result).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it.each([
    ["base", { base: "", projectDir: "/tmp/project", slug: "test-slug" }],
    ["slug", { base: "abc123", projectDir: "/tmp/project", slug: "" }],
  ])("returns false and never calls spawnFn when %s is empty", (_label, partial) => {
    const spawnFn = vi.fn<SpawnFn>();
    const result = triggerT2Recorder({ ...partial, worktree }, spawnFn);

    expect(result).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("dispatches with --root = projectDir, an args array (no shell), and returns true on the happy path", () => {
    const child = fakeChild();
    const spawnFn = vi.fn<SpawnFn>().mockReturnValue(child as never);

    const result = triggerT2Recorder(
      { base: "deadbeef", projectDir: "/main/checkout", slug: "my-slug", worktree },
      spawnFn,
    );

    expect(result).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnFn.mock.calls[0];
    expect(command).toBe("npx");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("--root");
    expect(args[args.indexOf("--root") + 1]).toBe("/main/checkout");
    expect(args).toContain("--worktree");
    expect(args[args.indexOf("--worktree") + 1]).toBe(worktree);
    expect(args).toContain("--base");
    expect(args[args.indexOf("--base") + 1]).toBe("deadbeef");
    expect(args).toContain("--slug");
    expect(args[args.indexOf("--slug") + 1]).toBe("my-slug");
    // --head is deliberately never passed — the recorder resolves reviewed
    // HEAD itself via `git rev-parse HEAD` in the worktree.
    expect(args).not.toContain("--head");
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options.cwd).toBe(join("/main/checkout", "mcp-server"));

    // The trigger wires an absorbing error listener and unref()s the child —
    // the structural fire-and-forget contract (Probe 3).
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("appends --review-id only when provided", () => {
    const child = fakeChild();
    const spawnFn = vi.fn<SpawnFn>().mockReturnValue(child as never);

    triggerT2Recorder(
      {
        base: "deadbeef",
        projectDir: "/main/checkout",
        reviewId: "rev-42",
        slug: "my-slug",
        worktree,
      },
      spawnFn,
    );

    const [, args] = spawnFn.mock.calls[0];
    expect(args).toContain("--review-id");
    expect(args[args.indexOf("--review-id") + 1]).toBe("rev-42");
  });

  it("absorbs an async error event without letting it escape (Probe 3b shape)", async () => {
    let registeredErrorHandler: ((err: Error) => void) | undefined;
    const child = {
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error") registeredErrorHandler = handler;
        return child;
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn<SpawnFn>().mockReturnValue(child as never);

    const result = triggerT2Recorder(
      { base: "abc123", projectDir: "/tmp/project", slug: "test-slug", worktree },
      spawnFn,
    );

    expect(result).toBe(true);
    expect(registeredErrorHandler).toBeDefined();

    // Simulate the async ENOENT the real spawn would emit — must not throw
    // or reject when the registered no-op handler runs it.
    expect(() => registeredErrorHandler?.(new Error("ENOENT"))).not.toThrow();
  });
});
