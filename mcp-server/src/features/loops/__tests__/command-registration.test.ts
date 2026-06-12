/**
 * dc-05 regression guard: asserts that plugin.json registers the commands directory
 * so that /canon:loop-tick (and all other slash commands) are harness-discoverable.
 *
 * This guard MUST live under mcp-server/src/ so that `npm test` (working-directory: mcp-server)
 * picks it up. A repo-root __tests__/ placement would be orphaned and never run in CI.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Resolve the repo root by walking up from this file's directory until we find
 * .claude-plugin/plugin.json — a unique repo-root marker. We assert its presence
 * rather than hardcoding a depth, so a directory restructure fails loudly here
 * instead of silently using the wrong root.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  throw new Error(
    `Could not locate repo root from ${startDir}: ` +
      ".claude-plugin/plugin.json not found within 10 ancestor levels. " +
      "If the test file was moved, update the marker-walk depth or anchor.",
  );
}

describe("plugin.json commands registration (dc-05 regression guard)", () => {
  const repoRoot = findRepoRoot(import.meta.dirname);

  it("resolves the repo root via the .claude-plugin/plugin.json marker", () => {
    const markerPath = join(repoRoot, ".claude-plugin", "plugin.json");
    expect(
      existsSync(markerPath),
      `Marker not found at ${markerPath} — repo root resolution is broken`,
    ).toBe(true);
  });

  it("plugin.json has a non-empty commands array", () => {
    const manifestPath = join(repoRoot, ".claude-plugin", "plugin.json");
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;

    expect(
      Array.isArray(manifest.commands),
      'plugin.json must have a "commands" array — ' +
        "without it the harness never registers /canon:loop-tick or any other slash command. " +
        `Add: "commands": ["./skills/canon/commands/"]`,
    ).toBe(true);

    const commands = manifest.commands as unknown[];
    expect(commands.length, '"commands" array must not be empty').toBeGreaterThan(0);
  });

  it("every entry in commands resolves to an existing path on disk", () => {
    const manifestPath = join(repoRoot, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const commands = manifest.commands as string[];

    for (const entry of commands) {
      const resolved = resolve(repoRoot, entry);
      expect(
        existsSync(resolved),
        `commands entry "${entry}" resolves to "${resolved}" which does not exist on disk`,
      ).toBe(true);
    }
  });

  it("the resolved command set includes loop-tick.md", () => {
    const manifestPath = join(repoRoot, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const commands = manifest.commands as string[];

    // Collect all .md files from every commands directory entry
    const mdFiles: string[] = [];
    for (const entry of commands) {
      const resolved = resolve(repoRoot, entry);
      if (existsSync(resolved)) {
        const files = readdirSync(resolved).filter((f) => f.endsWith(".md"));
        mdFiles.push(...files);
      }
    }

    expect(
      mdFiles.includes("loop-tick.md"),
      `loop-tick.md not found in registered commands. Found: ${mdFiles.join(", ")}. ` +
        "Ensure skills/canon/commands/loop-tick.md exists and the commands path in plugin.json is correct.",
    ).toBe(true);
  });

  it("the command set contains at least 14 .md files (catches accidental directory truncation)", () => {
    const manifestPath = join(repoRoot, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const commands = manifest.commands as string[];

    const mdFiles: string[] = [];
    for (const entry of commands) {
      const resolved = resolve(repoRoot, entry);
      if (existsSync(resolved)) {
        const files = readdirSync(resolved).filter((f) => f.endsWith(".md"));
        mdFiles.push(...files);
      }
    }

    expect(
      mdFiles.length,
      `Expected at least 14 .md command files but found ${mdFiles.length}: ${mdFiles.join(", ")}. ` +
        "If commands were intentionally removed, lower this threshold — otherwise a file was accidentally deleted.",
    ).toBeGreaterThanOrEqual(14);
  });
});
