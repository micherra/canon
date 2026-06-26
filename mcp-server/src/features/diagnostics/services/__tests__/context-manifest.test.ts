/**
 * context-manifest.test.ts
 *
 * TDD tests for buildContextManifest and checkContextStaleness.
 *
 * Strategy: use a temp dir as fixture tree; write markdown files to represent
 * the context corpus. Tests verify determinism, tamper detection (drifted),
 * missing file detection, extra file detection, and clean-tree check.
 */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextManifest,
  type ContextManifest,
  checkContextStaleness,
} from "../context-manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

let tmpDir: string;

async function setupFixtureTree(files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relPath, content]) => {
      const fullPath = join(tmpDir, relPath);
      await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }),
  );
}

// plugin.json must exist for buildContextManifest to read version
async function writePluginJson(version: string): Promise<void> {
  const pluginDir = join(tmpDir, ".claude-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ version }), "utf-8");
}

beforeEach(async () => {
  tmpDir = join(
    "/tmp",
    `context-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildContextManifest
// ---------------------------------------------------------------------------

describe("buildContextManifest", () => {
  it("returns deterministic sorted hashes for a small fixture tree", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "principles/rules/a.md": "# Rule A\ncontent a",
      "rules/b.md": "# Rule B\ncontent b",
    });

    const manifest = await buildContextManifest(tmpDir);

    expect(manifest.version).toBe("1.0.0");
    // Keys are POSIX-relative and sorted
    const keys = Object.keys(manifest.artifacts);
    expect(keys).toEqual([...keys].sort());
    // Hashes match expected sha256
    expect(manifest.artifacts["principles/rules/a.md"]).toBe(sha256("# Rule A\ncontent a"));
    expect(manifest.artifacts["rules/b.md"]).toBe(sha256("# Rule B\ncontent b"));
  });

  it("produces identical output on two successive calls (deterministic)", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "agents/agent.md": "# Agent",
      "templates/t.md": "template",
    });

    const m1 = await buildContextManifest(tmpDir);
    const m2 = await buildContextManifest(tmpDir);
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });

  it("ignores non-markdown files and empty directories", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "principles/rules/rule.md": "# Rule",
      "principles/rules/data.json": '{"foo":"bar"}', // not markdown, should be ignored
    });

    const manifest = await buildContextManifest(tmpDir);
    expect(Object.keys(manifest.artifacts)).not.toContain("principles/rules/data.json");
    expect(Object.keys(manifest.artifacts)).toContain("principles/rules/rule.md");
  });

  it("returns version 'unknown' when plugin.json is missing", async () => {
    await setupFixtureTree({ "rules/r.md": "rule" });
    const manifest = await buildContextManifest(tmpDir);
    expect(manifest.version).toBe("unknown");
  });

  it("only scans the 6 corpus directories", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "principles/rules/r.md": "rule",
      "docs/some.md": "docs file", // NOT in corpus
      "hooks/hook.md": "hook file", // NOT in corpus
    });

    const manifest = await buildContextManifest(tmpDir);
    const keys = Object.keys(manifest.artifacts);
    expect(keys).toContain("principles/rules/r.md");
    expect(keys).not.toContain("docs/some.md");
    expect(keys).not.toContain("hooks/hook.md");
  });
});

// ---------------------------------------------------------------------------
// checkContextStaleness
// ---------------------------------------------------------------------------

describe("checkContextStaleness", () => {
  it("returns clean:true for a tree matching its own manifest", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "principles/strong-opinions/a.md": "# Principle A",
      "rules/b.md": "# Rule B",
    });

    const manifest = await buildContextManifest(tmpDir);
    const report = await checkContextStaleness(tmpDir, manifest);

    expect(report.clean).toBe(true);
    expect(report.drifted).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
    expect(report.extra).toHaveLength(0);
  });

  it("reports drifted: a file present in both manifest and tree but with different content", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({ "principles/rules/rule.md": "original content" });

    const manifest = await buildContextManifest(tmpDir);

    // tamper the file after building the manifest
    await writeFile(join(tmpDir, "principles/rules/rule.md"), "tampered content", "utf-8");

    const report = await checkContextStaleness(tmpDir, manifest);
    expect(report.clean).toBe(false);
    expect(report.drifted).toContain("principles/rules/rule.md");
    expect(report.missing).toHaveLength(0);
    expect(report.extra).toHaveLength(0);
  });

  it("reports missing: a file in the manifest that is absent on disk", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({ "agents/agent.md": "# Agent" });

    const manifest = await buildContextManifest(tmpDir);

    // delete the file after building manifest
    await rm(join(tmpDir, "agents/agent.md"));

    const report = await checkContextStaleness(tmpDir, manifest);
    expect(report.clean).toBe(false);
    expect(report.missing).toContain("agents/agent.md");
    expect(report.drifted).toHaveLength(0);
  });

  it("reports extra: a file on disk that is not in the manifest", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({ "templates/t.md": "# Template" });

    const manifest = await buildContextManifest(tmpDir);

    // add a new file after building manifest
    await mkdir(join(tmpDir, "references"), { recursive: true });
    await writeFile(join(tmpDir, "references/new.md"), "# New Reference", "utf-8");

    const report = await checkContextStaleness(tmpDir, manifest);
    expect(report.clean).toBe(false);
    expect(report.extra).toContain("references/new.md");
    expect(report.missing).toHaveLength(0);
  });

  it("an unreadable file is surfaced as missing (not hashed as empty string)", async () => {
    // Simulate an unreadable file by injecting a manifest entry whose hash
    // doesn't exist on disk (file not present = missing, not drifted-to-empty)
    const manifest: ContextManifest = {
      version: "1.0.0",
      artifacts: {
        "principles/rules/secret.md": sha256("original secret"),
      },
    };

    // no file at that path — install a dir instead to make it unreadable
    await mkdir(join(tmpDir, "principles/rules/secret.md"), { recursive: true });

    const report = await checkContextStaleness(tmpDir, manifest);
    // Should NOT appear in drifted (drifted means same path but different hash)
    // Should appear as missing (can't read = treat as absent)
    expect(report.drifted).not.toContain("principles/rules/secret.md");
    expect(report.missing).toContain("principles/rules/secret.md");
    expect(report.clean).toBe(false);
  });
});
