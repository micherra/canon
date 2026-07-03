/**
 * context-manifest.test.ts
 *
 * TDD tests for buildContextManifest, checkContextStaleness, and the
 * freshness-gate comparison primitives (serializeManifest, diffManifests,
 * renderManifestDrift — sug_MANIFESTGAP1).
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
  diffManifests,
  renderManifestDrift,
  serializeManifest,
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

// ---------------------------------------------------------------------------
// serializeManifest
// ---------------------------------------------------------------------------

describe("serializeManifest", () => {
  it("matches the exact write-path byte format (2-space indent, trailing newline, version before artifacts)", async () => {
    await writePluginJson("1.0.0");
    await setupFixtureTree({
      "rules/b.md": "# Rule B",
      "agents/agent.md": "# Agent",
    });

    const manifest = await buildContextManifest(tmpDir);
    const serialized = serializeManifest(manifest);

    const expected = `${JSON.stringify({ version: manifest.version, artifacts: manifest.artifacts }, null, 2)}\n`;
    expect(serialized).toBe(expected);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("round-trips: parsing the serialized output reproduces the same manifest", async () => {
    await writePluginJson("2.3.1");
    await setupFixtureTree({ "templates/t.md": "template body" });

    const manifest = await buildContextManifest(tmpDir);
    const serialized = serializeManifest(manifest);
    const parsed = JSON.parse(serialized) as ContextManifest;

    expect(parsed).toEqual(manifest);
  });
});

// ---------------------------------------------------------------------------
// diffManifests
// ---------------------------------------------------------------------------

describe("diffManifests", () => {
  const base: ContextManifest = {
    version: "1.0.0",
    artifacts: {
      "agents/a.md": sha256("a"),
      "rules/b.md": sha256("b"),
    },
  };

  it("reports clean when committed and fresh are identical", () => {
    const diff = diffManifests(base, { ...base, artifacts: { ...base.artifacts } });
    expect(diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      versionChanged: null,
      clean: true,
    });
  });

  it("reports added when fresh has a key not in committed (new corpus file)", () => {
    const fresh: ContextManifest = {
      version: "1.0.0",
      artifacts: { ...base.artifacts, "templates/new.md": sha256("new") },
    };
    const diff = diffManifests(base, fresh);
    expect(diff.added).toEqual(["templates/new.md"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.clean).toBe(false);
  });

  it("reports removed when committed has a key not in fresh (deleted corpus file)", () => {
    const fresh: ContextManifest = {
      version: "1.0.0",
      artifacts: { "agents/a.md": base.artifacts["agents/a.md"] },
    };
    const diff = diffManifests(base, fresh);
    expect(diff.removed).toEqual(["rules/b.md"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.clean).toBe(false);
  });

  it("reports changed when a shared key has a differing hash (edited content)", () => {
    const fresh: ContextManifest = {
      version: "1.0.0",
      artifacts: { ...base.artifacts, "rules/b.md": sha256("edited b") },
    };
    const diff = diffManifests(base, fresh);
    expect(diff.changed).toEqual(["rules/b.md"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.clean).toBe(false);
  });

  it("reports versionChanged when the plugin version differs, and is not clean", () => {
    const fresh: ContextManifest = { version: "1.1.0", artifacts: { ...base.artifacts } };
    const diff = diffManifests(base, fresh);
    expect(diff.versionChanged).toEqual({ from: "1.0.0", to: "1.1.0" });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.clean).toBe(false);
  });

  it("sorts added/removed/changed lexicographically", () => {
    const fresh: ContextManifest = {
      version: "1.0.0",
      artifacts: {
        "templates/z.md": sha256("z"),
        "agents/y.md": sha256("y"),
      },
    };
    const diff = diffManifests(base, fresh);
    expect(diff.removed).toEqual(["agents/a.md", "rules/b.md"]);
    expect(diff.added).toEqual(["agents/y.md", "templates/z.md"]);
  });
});

// ---------------------------------------------------------------------------
// renderManifestDrift
// ---------------------------------------------------------------------------

describe("renderManifestDrift", () => {
  const FIX_COMMAND = "cd mcp-server && npm run regen:context-manifest";

  it("names added/removed/changed paths and includes the exact fix command", () => {
    const diff = diffManifests(
      {
        version: "1.0.0",
        artifacts: {
          "rules/b.md": sha256("b"),
          "agents/a.md": sha256("a"),
        },
      },
      {
        version: "1.0.0",
        artifacts: {
          "rules/b.md": sha256("edited b"),
          "templates/new.md": sha256("new"),
        },
      },
    );

    const message = renderManifestDrift(diff);
    expect(message).toContain("STALE");
    expect(message).toContain("templates/new.md"); // added
    expect(message).toContain("agents/a.md"); // removed
    expect(message).toContain("rules/b.md"); // changed
    expect(message).toContain(FIX_COMMAND);
  });

  it("includes the version delta line when versionChanged is set", () => {
    const diff = diffManifests(
      { version: "1.0.0", artifacts: {} },
      { version: "1.1.0", artifacts: {} },
    );
    const message = renderManifestDrift(diff);
    expect(message).toContain("1.0.0");
    expect(message).toContain("1.1.0");
    expect(message).toContain(FIX_COMMAND);
  });

  it("omits empty categories and stays pure (no throw) for a clean diff", () => {
    const diff = diffManifests(
      { version: "1.0.0", artifacts: {} },
      { version: "1.0.0", artifacts: {} },
    );
    expect(() => renderManifestDrift(diff)).not.toThrow();
    const message = renderManifestDrift(diff);
    expect(message).toContain(FIX_COMMAND);
  });
});
