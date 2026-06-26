#!/usr/bin/env tsx
/**
 * regen-context-manifest.ts — Regenerate context-manifest.json at the repo root.
 *
 * Scans the 6 canonical corpus directories (principles, rules, references,
 * primers, agents, templates), hashes every .md file, reads the plugin version,
 * and writes a deterministic sorted-key JSON manifest to <repo-root>/context-manifest.json.
 *
 * Usage (from repo root):
 *   cd mcp-server && npm run regen:context-manifest
 *
 * Run this after updating any corpus .md file or bumping the plugin version.
 * The committed manifest is checked by `check_context_staleness` (Canon doctor
 * Check 13) and by context-manifest.test.ts to detect installation drift.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextManifest } from "../src/features/diagnostics/services/context-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/
const repoRoot = join(scriptDir, "..", ".."); // two levels up → repo root
const outputPath = join(repoRoot, "context-manifest.json");

const manifest = await buildContextManifest(repoRoot);

// Write keys in canonical order (version before artifacts) with sorted artifact keys.
// buildContextManifest already sorts artifact keys lexicographically; preserve that order.
const output = `${JSON.stringify({ version: manifest.version, artifacts: manifest.artifacts }, null, 2)}\n`;

await writeFile(outputPath, output, "utf-8");

console.log(`context-manifest.json regenerated — ${Object.keys(manifest.artifacts).length} artifacts, version ${manifest.version}`);
