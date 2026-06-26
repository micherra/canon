/**
 * context-manifest-unreadable-dir.test.ts
 *
 * Regression test for Codex P2 finding: when a corpus directory EXISTS but its
 * readdir call throws EACCES/EPERM during the extra-file scan, checkContextStaleness
 * must return a valid StalenessReport — NOT rethrow the error as UNEXPECTED.
 *
 * The hash step already tolerates unreadable files (hashFile returns null → missing).
 * The extra-scan step must be equally robust for unreadable directories.
 *
 * Strategy: vi.mock node:fs/promises to control readdir per test. The default
 * mock implementation calls through to the real readdir so all other tests in the
 * suite remain unaffected.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextManifest, checkContextStaleness } from "../context-manifest.ts";

// ---------------------------------------------------------------------------
// Hoist the spy so vi.mock can reference it before imports are processed
// ---------------------------------------------------------------------------

const readdirSpy = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Default: call through to the real implementation
  readdirSpy.mockImplementation(actual.readdir.bind(actual));
  return { ...actual, readdir: readdirSpy };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function makeEaccesError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
}

function makeEpermError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkContextStaleness — unreadable corpus directory", () => {
  /** Path to a fake install directory; nothing is created on disk in these tests. */
  let installedDir: string;
  /** Real readdir for call-through in per-test overrides. */
  let realReaddir: (path: string) => Promise<string[]>;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    realReaddir = (path: string) => actual.readdir(path) as Promise<string[]>;
  });

  beforeEach(() => {
    installedDir = `/tmp/ctx-manifest-eacces-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Restore call-through before each test so tests are isolated
    readdirSpy.mockImplementation(realReaddir);
  });

  afterEach(() => {
    // Restore call-through after each test
    readdirSpy.mockImplementation(realReaddir);
  });

  it("EACCES on corpus dir during extra scan: returns valid StalenessReport, does NOT throw", async () => {
    // Arrange: manifest with a 'rules/' entry
    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: { "rules/x.md": sha256("some content") },
    };

    // Intercept readdir for the 'rules' corpus directory to simulate EACCES
    const rulesDir = join(installedDir, "rules");
    readdirSpy.mockImplementation(async (path: string) => {
      if (path === rulesDir) throw makeEaccesError();
      return realReaddir(path);
    });

    // Act: should NOT throw — must return a StalenessReport
    const report = await checkContextStaleness(installedDir, manifest);

    // Assert: valid StalenessReport returned
    expect(report).toHaveProperty("clean");
    expect(report).toHaveProperty("drifted");
    expect(report).toHaveProperty("missing");
    expect(report).toHaveProperty("extra");

    // rules/x.md: the hash step calls readFile on a non-existent path → null → missing
    expect(report.missing).toContain("rules/x.md");
    // The extra-scan for rules/ returned [] (EACCES tolerated) → no spurious extra entries
    expect(report.extra).toHaveLength(0);
    expect(report.clean).toBe(false);
  });

  it("EPERM on corpus dir during extra scan: returns valid StalenessReport, does NOT throw", async () => {
    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: { "agents/agent.md": sha256("agent content") },
    };

    const agentsDir = join(installedDir, "agents");
    readdirSpy.mockImplementation(async (path: string) => {
      if (path === agentsDir) throw makeEpermError();
      return realReaddir(path);
    });

    const report = await checkContextStaleness(installedDir, manifest);

    expect(report).toHaveProperty("clean");
    expect(report.missing).toContain("agents/agent.md");
    expect(report.extra).toHaveLength(0);
    expect(report.clean).toBe(false);
  });

  it("still rethrows genuinely unexpected readdir errors (e.g. EFAULT)", async () => {
    // Manifest is empty: no hash step, but the extra-scan iterates all 6 corpus dirs
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };

    // Make every readdir call throw EFAULT (unexpected error code)
    readdirSpy.mockImplementation(async () => {
      throw Object.assign(new Error("EFAULT: bad address"), { code: "EFAULT" });
    });

    // Should rethrow — EFAULT is NOT in the tolerated set
    await expect(checkContextStaleness(installedDir, manifest)).rejects.toThrow("EFAULT");
  });
});
