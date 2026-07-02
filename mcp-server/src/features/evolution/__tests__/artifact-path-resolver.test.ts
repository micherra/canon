/**
 * artifact-path-resolver.test.ts — unit tests for resolveArtifactReadPath.
 *
 * Covers the cross-root re-read resolver (Codex P2 #1, ADR-0031/ADR-0027 trust
 * boundary). project_dir-first, pluginDir-fallback gated on the
 * PLUGIN_ARTIFACT_ROOTS trusted-tier proxy.
 *
 * Canon principles:
 *   - validate-at-trust-boundaries: overlay (.canon/) paths NEVER fall back to pluginDir
 *   - errors-are-values: genuinely-missing → project_dir path (fail-closed, no throw)
 *   - simplicity-first: pure resolver, no schema change
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveArtifactReadPath } from "../services/artifact-path-resolver.ts";

let projectDir: string;
let pluginDir: string;

function writeFileAt(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "canon-proj-"));
  pluginDir = mkdtempSync(join(tmpdir(), "canon-plugin-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
});

describe("resolveArtifactReadPath", () => {
  it("self-host: artifact present in both roots → resolves to project_dir copy", () => {
    writeFileAt(projectDir, "agents/engineer.md", "project copy");
    writeFileAt(pluginDir, "agents/engineer.md", "plugin copy");

    const resolved = resolveArtifactReadPath("agents/engineer.md", projectDir, pluginDir);

    expect(resolved).toBe(join(projectDir, "agents/engineer.md"));
  });

  it("foreign install: plugin-tier artifact absent from project → resolves to pluginDir copy", () => {
    writeFileAt(pluginDir, "rules/foo.md", "plugin copy");

    const resolved = resolveArtifactReadPath("rules/foo.md", projectDir, pluginDir);

    expect(resolved).toBe(join(pluginDir, "rules/foo.md"));
    expect(existsSync(resolved)).toBe(true);
  });

  it("overlay: .canon/ path present only under plugin → project_dir path, no fallback", () => {
    writeFileAt(pluginDir, ".canon/principles/foo.md", "plugin overlay copy");

    const resolved = resolveArtifactReadPath(".canon/principles/foo.md", projectDir, pluginDir);

    expect(resolved).toBe(join(projectDir, ".canon/principles/foo.md"));
    expect(existsSync(resolved)).toBe(false);
  });

  it("genuinely missing from both → project_dir path (fail-closed)", () => {
    const resolved = resolveArtifactReadPath("rules/missing.md", projectDir, pluginDir);

    expect(resolved).toBe(join(projectDir, "rules/missing.md"));
    expect(existsSync(resolved)).toBe(false);
  });

  it("absolute path → returned as-is", () => {
    const abs = join(pluginDir, "agents/engineer.md");
    writeFileAt(pluginDir, "agents/engineer.md", "plugin copy");

    const resolved = resolveArtifactReadPath(abs, projectDir, pluginDir);

    expect(resolved).toBe(abs);
  });

  it("no pluginDir → prior join(project_dir, path) behavior for a plugin-tier miss", () => {
    writeFileAt(pluginDir, "rules/foo.md", "plugin copy");

    const resolved = resolveArtifactReadPath("rules/foo.md", projectDir);

    expect(resolved).toBe(join(projectDir, "rules/foo.md"));
    expect(existsSync(resolved)).toBe(false);
  });

  it("non-plugin-root relative path (mcp-server/) never falls back to pluginDir", () => {
    writeFileAt(pluginDir, "mcp-server/x.ts", "plugin copy");

    const resolved = resolveArtifactReadPath("mcp-server/x.ts", projectDir, pluginDir);

    expect(resolved).toBe(join(projectDir, "mcp-server/x.ts"));
    expect(existsSync(resolved)).toBe(false);
  });
});
