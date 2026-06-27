/**
 * check-context-staleness-eacces.test.ts
 *
 * Regression test for Codex P2 finding (tool handler level):
 * when the extra-file scan throws EACCES on a corpus directory, the
 * check_context_staleness handler must return { ok: true } with a valid
 * StalenessReport — NOT throw, which would be caught as UNEXPECTED by
 * the production gatedWrapHandler.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextManifest } from "../../services/context-manifest.ts";
import { checkContextStaleness as checkContextStalenessHandler } from "../check-context-staleness.ts";

// ---------------------------------------------------------------------------
// Hoist spy and mock node:fs/promises
// ---------------------------------------------------------------------------

const readdirSpy = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readdirSpy.mockImplementation(actual.readdir.bind(actual));
  return { ...actual, readdir: readdirSpy };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("check_context_staleness handler — unreadable corpus directory", () => {
  let tmpDir: string;
  let realReaddir: (path: string) => Promise<string[]>;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    realReaddir = (path: string) => actual.readdir(path) as Promise<string[]>;
  });

  beforeEach(async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/ccs-eacces-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });

    // Write a manifest that references a rules/ path
    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: { "rules/x.md": sha256("content") },
    };
    await writeFile(
      join(tmpDir, "context-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    readdirSpy.mockImplementation(realReaddir);
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
    readdirSpy.mockImplementation(realReaddir);
  });

  it("returns { ok: true } with StalenessReport when corpus dir readdir throws EACCES", async () => {
    // Simulate EACCES on the 'rules' corpus directory during extra scan
    const rulesDir = join(tmpDir, "rules");
    readdirSpy.mockImplementation(async (path: string) => {
      if (path === rulesDir) {
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      }
      return realReaddir(path);
    });

    const result = await checkContextStalenessHandler({ project_dir: tmpDir });

    // Must NOT throw and must NOT return ok:false due to an UNEXPECTED error
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result).toHaveProperty("clean");
      expect(result).toHaveProperty("drifted");
      expect(result).toHaveProperty("missing");
      expect(result).toHaveProperty("extra");
      // rules/x.md is in manifest but unreadable → missing
      expect(result.missing).toContain("rules/x.md");
      expect(result.clean).toBe(false);
    }
  });
});
