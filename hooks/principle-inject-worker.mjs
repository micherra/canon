#!/usr/bin/env node
/**
 * Canon Principle Injection Worker
 * Loads principles matching a file path and outputs compact summaries.
 * Used by principle-inject.sh hook to inject context into Claude Code.
 *
 * Usage: node principle-inject-worker.mjs <file_path>
 * Env:   CANON_PROJECT_DIR, CANON_PLUGIN_DIR
 */

import { resolve, join } from "path";

const filePath = process.argv[2];
if (!filePath) process.exit(0);

const projectDir = resolve(process.env.CANON_PROJECT_DIR || process.cwd());
const pluginDir = resolve(
  process.env.CANON_PLUGIN_DIR ||
    new URL("../mcp-server", import.meta.url).pathname
);

// Import compiled matcher from the MCP server dist
let loadAllPrinciples, matchPrinciples;
try {
  const matcher = await import(join(pluginDir, "dist", "matcher.js"));
  loadAllPrinciples = matcher.loadAllPrinciples;
  matchPrinciples = matcher.matchPrinciples;
} catch {
  // Matcher not available (not built yet) — skip silently
  process.exit(0);
}

const MAX_PRINCIPLES = 3;

try {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const matched = matchPrinciples(allPrinciples, { file_path: filePath });
  const top = matched.slice(0, MAX_PRINCIPLES);

  if (top.length === 0) process.exit(0);

  // Extract first paragraph as summary
  const summaries = top.map((p) => {
    const summary = p.body.split(/\n\n/)[0]?.trim() || p.title;
    // Cap each summary at 150 chars
    const text = summary.length > 150 ? summary.slice(0, 147) + "..." : summary;
    return `  [${p.severity}] ${p.id}: ${text}`;
  });

  console.log(`CANON PRINCIPLES for ${filePath}:`);
  console.log(summaries.join("\n"));
} catch {
  // Any error — exit silently, never block
  process.exit(0);
}
