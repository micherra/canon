#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { execFileSync } from "node:child_process";

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args.shift();
  if (!cmd) die("Missing command: bundle | install");

  const opts = { _: args };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") opts.force = true;
    else if (a === "--bundle-path") opts.bundlePath = args[i + 1];
    else if (a === "--bundle-url") opts.bundleUrl = args[i + 1];
    else if (a === "--out-dir") opts.outDir = args[i + 1];
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) die(`Unknown option: ${a}`);
  }
  return { cmd, opts };
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

function copyIntoTarget({ stageRoot, relPath, targetRoot, force }) {
  const src = path.join(stageRoot, relPath);
  const dst = path.join(targetRoot, relPath);

  if (!exists(src)) return { skipped: true, reason: "missing-in-bundle", relPath };

  if (exists(dst) && !force) {
    return { skipped: true, reason: "exists", relPath };
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (exists(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  return { skipped: false, relPath };
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

function ensureTar() {
  // macOS ships tar; if it’s missing, we can’t bundle/extract.
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
  } catch {
    die("Missing `tar` binary (required for bundle/extract).");
  }
}

function cmdBundle(opts) {
  ensureTar();

  const repoRoot = process.cwd();
  const outDir = opts.outDir ? path.resolve(repoRoot, opts.outDir) : path.join(repoRoot, "dist");
  fs.mkdirSync(outDir, { recursive: true });

  const outTgz = path.join(outDir, "cursor-canon-everything.tgz");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-canon-bundle-"));
  const stageRoot = path.join(tmpDir, "cursor-canon-bundle");
  fs.mkdirSync(stageRoot, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    const include = [
      "AGENTS.md",
      "CURSOR.md",
      ".cursor/mcp.json",
      "mcp-server",
      "flows",
      "agents",
      "agent-rules",
      "principles",
      "templates",
      "hooks",
      "commands",
      "cursor-extension",
      "CLAUDE.md",
      ".mcp.json",
      ".cursor/agents",
      ".cursor/hooks"
    ];

    // Copy into stage root preserving relative structure
    for (const rel of include) {
      const src = path.join(repoRoot, rel);
      if (!exists(src)) continue; // allow missing optional pieces

      const dst = path.join(stageRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });

      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    // Create tar.gz from stageRoot
    if (exists(outTgz)) fs.rmSync(outTgz, { force: true });
    execFileSync("tar", ["-C", stageRoot, "-czf", outTgz, "."], { stdio: "inherit" });
    console.log(`Bundle created: ${outTgz}`);
  } finally {
    cleanup();
  }
}

async function cmdInstall(opts) {
  ensureTar();

  const targetRoot = process.cwd();
  const force = !!opts.force;

  if (!opts.bundlePath && !opts.bundleUrl) {
    die("install requires --bundle-path or --bundle-url");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-canon-install-"));
  const tgzPath = path.join(tmpDir, "cursor-canon-bundle.tgz");
  const extractedRoot = path.join(tmpDir, "extracted");
  fs.mkdirSync(extractedRoot, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    if (opts.bundleUrl) {
      console.log("Downloading bundle...");
      await downloadToFile(opts.bundleUrl, tgzPath);
    } else {
      const src = path.resolve(opts.bundlePath);
      if (!exists(src)) die(`Bundle path does not exist: ${src}`);
      fs.copyFileSync(src, tgzPath);
    }

    execFileSync("tar", ["-xzf", tgzPath, "-C", extractedRoot], { stdio: "ignore" });

    // Our tar was created from stageRoot, so extractedRoot contains the repo root contents directly.
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
      ".mcp.json"
    ];

    for (const rel of include) {
      const res = copyIntoTarget({ stageRoot, relPath: rel, targetRoot, force });
      if (!res.skipped) console.log(`Installed: ${rel}`);
    }

    console.log("");
    console.log("Done.");
    console.log("- Restart Cursor so it loads the project MCP config (.cursor/mcp.json).");
    console.log("- Trigger a Canon action in chat (e.g. 'Review my changes').");
  } finally {
    cleanup();
  }
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage:
  ${process.argv[1]} bundle [--out-dir dist]
  ${process.argv[1]} install --bundle-path /path/to.tgz [--force]
  ${process.argv[1]} install --bundle-url https://.../cursor-canon-everything.tgz [--force]`);
    return;
  }

  if (cmd === "bundle") return cmdBundle(opts);
  if (cmd === "install") return await cmdInstall(opts);

  die(`Unknown command: ${cmd} (expected bundle|install)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

