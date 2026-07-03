#!/usr/bin/env tsx
/**
 * regen-context-manifest.ts — Regenerate (or check) context-manifest.json.
 *
 * Scans the 6 canonical corpus directories (principles, rules, references,
 * primers, agents, templates), hashes every .md file, reads the plugin version,
 * and writes a deterministic sorted-key JSON manifest to <root>/context-manifest.json.
 *
 * Usage (from repo root):
 *   cd mcp-server && npm run regen:context-manifest                # write mode (default)
 *   cd mcp-server && npm run regen:context-manifest -- --check     # freshness check, no write
 *   cd mcp-server && npm run regen:context-manifest -- --root <dir> [--check]
 *
 * Run write mode after updating any corpus .md file or bumping the plugin
 * version. The committed manifest is checked by `check_context_staleness`
 * (advisory MCP tool) and by `hooks/context-manifest-gate.sh` (deterministic
 * verify-step gate, sug_MANIFESTGAP1) to detect drift.
 *
 * `--check` mode NEVER writes. It builds a fresh manifest in memory, compares
 * it byte-for-byte against the committed `<root>/context-manifest.json`, and
 * exits 0 (fresh) or 1 (stale / uncheckable) — fail-closed on any inability
 * to read or parse the committed manifest.
 *
 * `--root <dir>` overrides the scan root + manifest path (default: the repo
 * root derived from this script's location). Exists so callers (the shell
 * gate's test suite) can point the real builder at a fixture corpus.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContextManifest,
  type ContextManifest,
  diffManifests,
  renderManifestDrift,
  serializeManifest,
} from "../src/features/diagnostics/services/context-manifest.ts";

const FIX_COMMAND = "cd mcp-server && npm run regen:context-manifest";

type CheckResult =
  | { kind: "fresh" }
  | { kind: "unreadable"; manifestPath: string }
  | { kind: "unparseable"; manifestPath: string }
  | { kind: "stale"; message: string };

function parseArgs(argv: string[]): { check: boolean; root?: string } {
  let check = false;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") {
      check = true;
    } else if (argv[i] === "--root") {
      root = argv[i + 1];
      i++;
    }
  }
  return { check, root };
}

/**
 * Run the --check comparison. Never writes. Errors-are-values: every
 * uncheckable condition (unreadable/unparseable committed manifest) is a
 * result variant, not a throw.
 */
async function runCheck(root: string, manifestPath: string): Promise<CheckResult> {
  const fresh = await buildContextManifest(root);

  let committedRaw: string;
  try {
    committedRaw = await readFile(manifestPath, "utf-8");
  } catch {
    return { kind: "unreadable", manifestPath };
  }

  if (serializeManifest(fresh) === committedRaw) {
    return { kind: "fresh" };
  }

  let committed: ContextManifest;
  try {
    committed = JSON.parse(committedRaw) as ContextManifest;
  } catch {
    return { kind: "unparseable", manifestPath };
  }

  const diff = diffManifests(committed, fresh);
  return { kind: "stale", message: renderManifestDrift(diff) };
}

const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/
const defaultRepoRoot = join(scriptDir, "..", ".."); // two levels up → repo root

const { check, root: rootArg } = parseArgs(process.argv.slice(2));
const root = rootArg ?? defaultRepoRoot;
const manifestPath = join(root, "context-manifest.json");

if (!check) {
  // ---------------------------------------------------------------------
  // Write mode (default, unchanged behavior)
  // ---------------------------------------------------------------------
  const manifest = await buildContextManifest(root);
  await writeFile(manifestPath, serializeManifest(manifest), "utf-8");
  console.log(
    `context-manifest.json regenerated — ${Object.keys(manifest.artifacts).length} artifacts, version ${manifest.version}`,
  );
} else {
  // ---------------------------------------------------------------------
  // --check mode: never writes. Fail-closed on any uncheckable condition.
  // ---------------------------------------------------------------------
  const result = await runCheck(root, manifestPath);
  switch (result.kind) {
    case "fresh":
      console.log("context-manifest.json is fresh");
      break;
    case "unreadable":
      console.error(`STALE: committed manifest is unreadable or absent: ${result.manifestPath}`);
      console.error(`Fix: ${FIX_COMMAND}`);
      process.exitCode = 1;
      break;
    case "unparseable":
      console.error(`STALE: committed manifest is not valid JSON: ${result.manifestPath}`);
      console.error(`Fix: ${FIX_COMMAND}`);
      process.exitCode = 1;
      break;
    case "stale":
      console.error(result.message);
      process.exitCode = 1;
      break;
  }
}
