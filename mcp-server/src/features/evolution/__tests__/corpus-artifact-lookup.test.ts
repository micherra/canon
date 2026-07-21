/**
 * corpus-artifact-lookup.test.ts — Unit tests for buildCorpusArtifactLookup
 * (ADR-0062 Bug-1: the shared resolver spanning principles ∪ rules ∪
 * references ∪ primers ∪ templates).
 *
 * Uses isolated mkdtemp fixtures — NEVER process.cwd() (drift-db-leak-guard).
 *
 * Canon principles:
 *   - errors-are-values: an unresolvable id or malformed frontmatter file
 *     never throws — it drops out of the domain (null / skipped file)
 *   - no-llm-calls-in-mcp-tools: pure directory scan + frontmatter parse
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCorpusArtifactLookup } from "../services/corpus-artifact-lookup.ts";

let projectDir: string;
let pluginDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "corpus-lookup-project-"));
  pluginDir = mkdtempSync(join(tmpdir(), "corpus-lookup-plugin-"));
});

afterEach(() => {
  for (const dir of [projectDir, pluginDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort
    }
  }
});

function writeMd(root: string, relPath: string, frontmatter: string, body = "Body text."): void {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");
}

describe("buildCorpusArtifactLookup", () => {
  it("resolves a rules/*.md id", async () => {
    writeMd(projectDir, "rules/agent-tdd-required.md", "id: agent-tdd-required");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("agent-tdd-required");
    expect(resolved).not.toBeNull();
    expect(resolved?.artifact_class).toBe("rule");
    expect(resolved?.path).toBe("rules/agent-tdd-required.md");
    expect(resolved?.body).toContain("Body text.");
  });

  it("resolves a references/*.md id with class reference", async () => {
    writeMd(projectDir, "references/status-protocol.md", "id: status-protocol");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("status-protocol");
    expect(resolved?.artifact_class).toBe("reference");
    expect(resolved?.path).toBe("references/status-protocol.md");
  });

  it("resolves a primers/*.md id with class primer", async () => {
    writeMd(projectDir, "primers/testing.md", "id: testing");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    expect(lookup("testing")?.artifact_class).toBe("primer");
  });

  it("resolves a templates/*.md id with class template", async () => {
    writeMd(projectDir, "templates/summary.md", "id: summary");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    expect(lookup("summary")?.artifact_class).toBe("template");
  });

  it("resolves a principle id via loadAllPrinciples, class principle", async () => {
    writeMd(
      projectDir,
      ".canon/principles/rules/my-rule.md",
      "id: my-rule\ntitle: My Rule\nseverity: rule\nportable: true",
    );
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("my-rule");
    expect(resolved?.artifact_class).toBe("principle");
    expect(resolved?.path).toBe(".canon/principles/rules/my-rule.md");
  });

  it("principle beats a same-id dir-scan rule file (principles checked first)", async () => {
    writeMd(
      projectDir,
      ".canon/principles/rules/dup-id.md",
      "id: dup-id\ntitle: Dup\nseverity: rule\nportable: true",
      "Principle body.",
    );
    writeMd(projectDir, "rules/dup-id.md", "id: dup-id", "Rule body.");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("dup-id");
    expect(resolved?.artifact_class).toBe("principle");
    expect(resolved?.body).toContain("Principle body.");
  });

  it("project wins over plugin on id collision (dir-scan)", async () => {
    writeMd(projectDir, "rules/shared-id.md", "id: shared-id", "Project version.");
    writeMd(pluginDir, "rules/shared-id.md", "id: shared-id", "Plugin version.");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("shared-id");
    expect(resolved?.path).toBe("rules/shared-id.md");
    expect(resolved?.body).toContain("Project version.");
  });

  it("falls back to pluginDir when the id is absent from projectDir", async () => {
    writeMd(pluginDir, "references/plugin-only.md", "id: plugin-only", "Plugin body.");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    const resolved = lookup("plugin-only");
    expect(resolved?.artifact_class).toBe("reference");
    expect(resolved?.path).toBe("references/plugin-only.md");
  });

  it("fails open on a malformed frontmatter file — the file drops out of the domain", async () => {
    const badPath = join(projectDir, "rules", "malformed.md");
    mkdirSync(join(projectDir, "rules"), { recursive: true });
    writeFileSync(badPath, "---\nid: [unterminated\n---\n\nBody\n", "utf-8");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    expect(lookup("malformed")).toBeNull();
  });

  it("returns null for an id with no on-disk artifact anywhere", async () => {
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);
    expect(lookup("nonexistent-id")).toBeNull();
  });

  it("does not throw when a scanned dir is missing", async () => {
    // projectDir has no rules/references/primers/templates dirs at all.
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);
    expect(lookup("anything")).toBeNull();
  });

  it("excludes README.md from the dir scan", async () => {
    writeMd(projectDir, "rules/README.md", "id: readme-should-not-resolve");
    const lookup = await buildCorpusArtifactLookup(projectDir, pluginDir);

    expect(lookup("readme-should-not-resolve")).toBeNull();
  });

  it("self-host (projectDir === pluginDir) does not double-scan or throw", async () => {
    writeMd(projectDir, "rules/self-host.md", "id: self-host");
    const lookup = await buildCorpusArtifactLookup(projectDir, projectDir);

    const resolved = lookup("self-host");
    expect(resolved?.path).toBe("rules/self-host.md");
  });
});
