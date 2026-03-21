#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { force: false, bundlePath: null, bundleUrl: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") opts.force = true;
    else if (a === "--bundle-path") opts.bundlePath = args[++i];
    else if (a === "--bundle-url") opts.bundleUrl = args[++i];
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

const MAX_DOWNLOAD_REDIRECTS = 10;

function getOnce(urlString) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch {
      reject(new Error(`Download failed: invalid URL`));
      return;
    }

    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) {
      reject(new Error(`Download failed: unsupported URL protocol ${u.protocol}`));
      return;
    }

    const req = lib.get(urlString, (res) => resolve(res));
    req.on("error", reject);
  });
}

async function downloadToFile(url, destPath) {
  let currentUrl = url;
  let redirectsFollowed = 0;

  while (true) {
    const res = await getOnce(currentUrl);
    const code = res.statusCode ?? 0;

    if (code >= 300 && code < 400 && res.headers.location) {
      if (redirectsFollowed >= MAX_DOWNLOAD_REDIRECTS) {
        res.resume();
        throw new Error(`Download failed: too many redirects (max ${MAX_DOWNLOAD_REDIRECTS})`);
      }

      res.resume();
      currentUrl = new URL(res.headers.location, currentUrl).href;
      redirectsFollowed++;
      continue;
    }

    if (code >= 400) {
      res.resume();
      throw new Error(`Download failed: HTTP ${code}`);
    }

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
      res.on("error", reject);
    });
    return;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: canon-cursor [--force] [--bundle-path path] [--bundle-url url]`);
    console.log(`Installs Cursor Canon runner assets into the current repo.`);
    process.exit(0);
  }

  const targetRoot = process.cwd();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const bundleDefault = path.resolve(__dirname, "..", "bundle", "canon-cursor-everything.tgz");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-cursor-install-"));
  try {
    const extractedRoot = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractedRoot, { recursive: true });

    let bundlePath;
    if (opts.bundleUrl) {
      bundlePath = path.join(tmpDir, "canon-cursor-everything.tgz");
      await downloadToFile(opts.bundleUrl, bundlePath);
    } else {
      bundlePath = opts.bundlePath ? path.resolve(opts.bundlePath) : bundleDefault;
      if (!exists(bundlePath)) die(`Bundle not found: ${bundlePath}`);
    }

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

