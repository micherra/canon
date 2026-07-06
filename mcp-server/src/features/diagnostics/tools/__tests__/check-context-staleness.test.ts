/**
 * check-context-staleness.test.ts
 *
 * Integration tests for the check_context_staleness MCP tool handler.
 *
 * Strategy: import the handler directly (no MCP server needed), mock the
 * manifest-read seam via a temp dir. Covers:
 * - Happy path (clean tree)
 * - MANIFEST_NOT_FOUND on missing manifest file
 * - Drift detected → report lists drifted path, clean:false (AC#3 verification)
 */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextManifest } from "../../services/context-manifest.ts";
import {
  checkContextStalenessGuarded,
  checkContextStaleness as checkContextStalenessHandler,
} from "../check-context-staleness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    "/tmp",
    `check-staleness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeManifest(manifest: ContextManifest): Promise<void> {
  await writeFile(
    join(tmpDir, "context-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("check_context_staleness handler", () => {
  it("happy path: clean tree returns ok with clean:true", async () => {
    // Write a matching file + matching manifest
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    const content = "# Rule A";
    await writeFile(join(tmpDir, "rules/a.md"), content, "utf-8");

    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: { "rules/a.md": sha256(content) },
    };
    await writeManifest(manifest);

    const result = await checkContextStalenessHandler({
      project_dir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(true);
      expect(result.drifted).toHaveLength(0);
      expect(result.missing).toHaveLength(0);
      expect(result.extra).toHaveLength(0);
    }
  });

  it("MANIFEST_NOT_FOUND when manifest file is absent", async () => {
    // No manifest written — should return toolError
    const result = await checkContextStalenessHandler({
      project_dir: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("MANIFEST_NOT_FOUND");
    }
  });

  it("drift detected: stale file → report lists drifted path, clean:false (AC#3)", async () => {
    await mkdir(join(tmpDir, "agents"), { recursive: true });

    // Write a file with original content
    const originalContent = "# Original Agent";
    await writeFile(join(tmpDir, "agents/agent.md"), originalContent, "utf-8");

    // Manifest references the original hash
    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: { "agents/agent.md": sha256(originalContent) },
    };
    await writeManifest(manifest);

    // Tamper the file (simulate staleness between install and committed manifest)
    await writeFile(join(tmpDir, "agents/agent.md"), "# Tampered Agent", "utf-8");

    const result = await checkContextStalenessHandler({
      project_dir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(false);
      expect(result.drifted).toContain("agents/agent.md");
    }
  });

  it("accepts explicit manifest_path override", async () => {
    // Write manifest to a non-default location
    const customManifestPath = join(tmpDir, "custom-manifest.json");
    const manifest: ContextManifest = {
      version: "2.0.0",
      artifacts: {},
    };
    await writeFile(customManifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const result = await checkContextStalenessHandler({
      project_dir: tmpDir,
      manifest_path: customManifestPath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(true);
    }
  });

  it("MANIFEST_NOT_FOUND when manifest_path points to a non-existent file", async () => {
    const result = await checkContextStalenessHandler({
      project_dir: tmpDir,
      manifest_path: join(tmpDir, "no-such-file.json"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("MANIFEST_NOT_FOUND");
    }
  });
});

describe("check_context_staleness handler — scope containment guard (R6, Codex P2 fix)", () => {
  let scopeRoot: string;
  let sibling: string;

  beforeEach(async () => {
    scopeRoot = join(
      "/tmp",
      `ccs-scope-guard-root-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sibling = join(
      "/tmp",
      `ccs-scope-guard-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(scopeRoot, { recursive: true });
    await mkdir(sibling, { recursive: true });
  });

  afterEach(async () => {
    await rm(scopeRoot, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  });

  it("R6 out-of-scope reject: sibling project_dir is rejected fail-closed", async () => {
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };
    await writeFile(
      join(sibling, "context-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    const result = await checkContextStalenessGuarded({ project_dir: sibling }, scopeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain(sibling);
    }
  });

  it("R6 in-scope / same-path allow: delegates to checkContextStaleness", async () => {
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };
    await writeFile(
      join(scopeRoot, "context-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    const result = await checkContextStalenessGuarded({ project_dir: scopeRoot }, scopeRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(true);
    }
  });

  it("R6 subpath allow: worktree-shaped project_dir under scope succeeds", async () => {
    const worktreeDir = join(scopeRoot, ".canon", "workspaces", "test-slug", "worktree");
    await mkdir(worktreeDir, { recursive: true });
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };
    await writeFile(
      join(worktreeDir, "context-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    const result = await checkContextStalenessGuarded({ project_dir: worktreeDir }, scopeRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(true);
    }
  });

  it("R6 traversal reject: `..` escape outside scope is rejected", async () => {
    const escaped = join(scopeRoot, "a", "..", "..", "escape");

    const result = await checkContextStalenessGuarded({ project_dir: escaped }, scopeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("R6 manifest_path out-of-scope reject: sibling manifest_path is rejected fail-closed even with an in-scope project_dir", async () => {
    // project_dir is in-scope, but manifest_path points at a sibling file —
    // without a manifest_path guard this reads/parses an arbitrary out-of-scope file.
    const siblingManifestPath = join(sibling, "context-manifest.json");
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };
    await writeFile(siblingManifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const result = await checkContextStalenessGuarded(
      { manifest_path: siblingManifestPath, project_dir: scopeRoot },
      scopeRoot,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain(siblingManifestPath);
    }
  });

  it("R6 manifest_path in-scope allow: explicit in-scope manifest_path still returns a StalenessReport", async () => {
    const inScopeManifestPath = join(scopeRoot, "custom-manifest.json");
    const manifest: ContextManifest = { version: "1.0.0", artifacts: {} };
    await writeFile(inScopeManifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const result = await checkContextStalenessGuarded(
      { manifest_path: inScopeManifestPath, project_dir: scopeRoot },
      scopeRoot,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clean).toBe(true);
    }
  });

  it("R6 manifest_path omitted: default-path behavior is unaffected by the manifest_path guard", async () => {
    // No manifest written — MANIFEST_NOT_FOUND for the default path must still
    // surface, not the manifest_path scope-guard error (guard is skipped when omitted).
    const result = await checkContextStalenessGuarded({ project_dir: scopeRoot }, scopeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("MANIFEST_NOT_FOUND");
    }
  });
});
