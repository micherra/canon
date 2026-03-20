#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { force: false, bundlePath: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") opts.force = true;
    else if (a === "--bundle-path") opts.bundlePath = args[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else die(`Unknown arg: ${a}`);
  }
  return opts;
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyIntoTarget({ stageRoot, relPath, targetRoot, force }) {
  const src = path.join(stageRoot, relPath);
  const dst = path.join(targetRoot, relPath);

  if (!exists(src)) return { skipped: true, reason: "missing-in-bundle", relPath };

  if (exists(dst) && !force) return { skipped: true, reason: "exists", relPath };

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (exists(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  return { skipped: false, relPath };
}

function extractBundle({ bundlePath, extractedRoot }) {
  // Uses system `tar` for macOS/Linux compatibility.
  const res = spawnSync("tar", ["-xzf", bundlePath, "-C", extractedRoot], {
    stdio: "inherit",
  });
  if (res.status !== 0) die(`tar failed with code ${res.status}`);
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: cursor-canon [--force] [--bundle-path path]`);
    console.log(`Installs Cursor Canon runner assets into the current repo.`);
    process.exit(0);
  }

  const targetRoot = process.cwd();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const bundleDefault = path.resolve(__dirname, "..", "bundle", "cursor-canon-everything.tgz");

  const bundlePath = opts.bundlePath ? path.resolve(opts.bundlePath) : bundleDefault;
  if (!exists(bundlePath)) die(`Bundle not found: ${bundlePath}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-canon-install-"));
  try {
    const extractedRoot = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractedRoot, { recursive: true });

    extractBundle({ bundlePath, extractedRoot });

    const stageRoot = extractedRoot;

    const include = [
      "AGENTS.md",
      "CURSOR.md",
      ".cursor/mcp.json",
      ".cursor/agents",
      ".cursor/hooks",
      "mcp-server",
      "flows",
      "agents",
      "agent-rules",
      "principles",
      "templates",
      "hooks",
      "commands",
      "CLAUDE.md",
      ".mcp.json",
      "cursor-extension",
    ];

    let installed = 0;
    for (const rel of include) {
      const res = copyIntoTarget({ stageRoot, relPath: rel, targetRoot, force: !!opts.force });
      if (!res.skipped) installed++;
    }

    console.log(`Installed ${installed} items into ${targetRoot}`);
    console.log("Next:");
    console.log("- Restart Cursor so it loads the project MCP config (.cursor/mcp.json).");
    console.log("- Trigger a Canon action in chat (e.g. 'Review my changes').");
  } finally {
    // best-effort cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main();

