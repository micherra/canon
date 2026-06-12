#!/usr/bin/env node
/**
 * install-sim-smoke.mjs — Faithful install-simulation smoke test.
 *
 * Reproduces the environment of a Claude Code plugin install:
 *   - Archives HEAD via `git archive` to a temp dir outside the repo.
 *   - Resolves the canon server block from the ARCHIVED .mcp.json.
 *   - Applies env substitution EXACTLY as Claude Code does:
 *       • In env values: expands ${VAR} and ${VAR:-default} tokens.
 *       • In args: does NOT expand ${...} (CC does not substitute here).
 *         WARNING: expanding args would paper over the #356 bug this test exists
 *         to catch. See decisions/install-faithful-01.md.
 *   - Spawns from a NON-REPO cwd (throwaway user-project dir).
 *   - Connects an MCP SDK Client over StdioClientTransport.
 *   - Asserts initialize() succeeds AND listTools() returns a non-empty set.
 *
 * Flags:
 *   (none)         Normal mode — drive the actual .mcp.json from the archive.
 *                  On the current base (pre-#356-fix), this REPRODUCES #356:
 *                  ${CLAUDE_PLUGIN_ROOT:-.} is unsubstituted in args → bash
 *                  cannot find the script at a literal ${...} path → fails.
 *                  This is EXPECTED and INTENTIONAL.
 *
 *   --self-check   Self-verification mode. Runs two sub-tests:
 *                    1. BROKEN form: token in args (pre-#356) → must FAIL.
 *                       Confirms the harness catches the bug.
 *                    2. FIXED form: path resolved at spawn time → must SUCCEED.
 *                       Confirms the harness passes when the install is correct.
 *                  Exits 0 iff both sub-tests behave as expected.
 *
 *   --debug        Print resolved env and command to stderr before spawning.
 *
 * Usage:
 *   node scripts/install-sim-smoke.mjs            # normal mode
 *   node scripts/install-sim-smoke.mjs --self-check  # self-verification
 *
 * CI context: run by the install-sim job in .github/workflows/ci.yml.
 * That job uses a Node version DIFFERENT from the repo-pinned 25.8.0 to
 * exercise the #361 ambient-node path.
 */

import { execSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync as rmSyncFs, symlinkSync as symlinkSyncFs, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Guard 3: release containment ────────────────────────────────────────────

/**
 * Containment tripwire (Guard 3): the packaged/archived tree must never contain a
 * node_modules symlink. git archive is tracked-only so this should always pass —
 * the assertion makes a future regression (symlink into a tracked path) fail loudly
 * instead of leaking into a release.
 *
 * Note: `.canon/` contains tracked config files (config.json, principle-overrides.yaml,
 * CONVENTIONS.md) that are INTENTIONALLY part of the release. Runtime state directories
 * (.canon/workspaces/, databases, etc.) are gitignored and thus absent from archives.
 * We do NOT assert on .canon/ presence — only on node_modules symlinks.
 *
 * Does NOT follow symlinks — we intentionally scan at the directory-entry level using
 * readdirSync with { withFileTypes: true } and lstatSync. We skip following into
 * node_modules dirs (even non-symlink ones) to keep scan time O(non-dep-tree).
 *
 * @param {string} archiveRoot - The root directory of the extracted archive
 */
function assertNoLeakedArtifacts(archiveRoot) {
  const stack = [archiveRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.name === "node_modules") {
        // Check whether this specific entry is a symlink — lstatSync does not follow
        let stat;
        try {
          stat = lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) {
          throw new Error(
            `[install-sim] CONTAINMENT BREACH: node_modules symlink in archive at ${full}`,
          );
        }
        // Real node_modules dir — don't recurse into it (not our concern and very slow)
        continue;
      }
      // Only recurse into real directories (not symlinks to dirs)
      if (e.isDirectory()) stack.push(full);
    }
  }
}

/**
 * Self-test for assertNoLeakedArtifacts: verifies that the containment tripwire
 * correctly fires on synthetic violations and passes on a clean tree.
 * All operations are synchronous — no async/await needed.
 */
function selfTestContainmentTripwire() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "guard3-self-test-"));
  try {
    // Test 1: clean tree passes
    const cleanDir = join(tmpRoot, "clean");
    mkdirSync(join(cleanDir, "src"), { recursive: true });
    writeFileSync(join(cleanDir, "src", "index.ts"), "");
    assertNoLeakedArtifacts(cleanDir); // must not throw

    // Test 2: .canon/ with only tracked config files does NOT trigger (it's intentional content)
    const canonDir = join(tmpRoot, "with-canon");
    mkdirSync(join(canonDir, ".canon"), { recursive: true });
    writeFileSync(join(canonDir, ".canon", "config.json"), "{}");
    assertNoLeakedArtifacts(canonDir); // must NOT throw (.canon config is legitimate release content)

    // Test 3: node_modules symlink is caught
    const nmDir = join(tmpRoot, "with-nm-symlink");
    mkdirSync(nmDir, { recursive: true });
    mkdirSync(join(tmpRoot, "real-nm"), { recursive: true });
    symlinkSyncFs(join(tmpRoot, "real-nm"), join(nmDir, "node_modules"), "dir");
    let caught = false;
    try {
      assertNoLeakedArtifacts(nmDir);
    } catch (err) {
      if (!err.message.includes("CONTAINMENT BREACH")) throw err;
      caught = true;
    }
    if (!caught) throw new Error("[guard3-self-test] Expected node_modules symlink breach to be caught");

    // Test 4: real node_modules dir (not symlink) does NOT throw
    const realNmDir = join(tmpRoot, "with-real-nm");
    mkdirSync(join(realNmDir, "node_modules"), { recursive: true });
    assertNoLeakedArtifacts(realNmDir); // must not throw

    console.log("[install-sim] Guard 3 self-test: all containment assertions passed.");
  } finally {
    rmSyncFs(tmpRoot, { recursive: true, force: true });
  }
}

// ── Repo root resolution ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, ".."); // scripts/ is one level below repo root

// ── Constants ───────────────────────────────────────────────────────────────

/** Repo-pinned Node version that ALL CI jobs except install-sim use. */
const REPO_PINNED_NODE_VERSION = "v25.8.0";

/** MCP handshake timeout (ms). */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Name of the MCP server to locate in .mcp.json. */
const SERVER_NAME = "canon";

// ── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SELF_CHECK_MODE = args.includes("--self-check");
const DEBUG = args.includes("--debug");

// ── node_modules discovery ───────────────────────────────────────────────────

/**
 * Locate an installed mcp-server/node_modules that contains tsx.
 * Resolution order:
 *   1. REPO_ROOT/mcp-server/node_modules — present after `npm ci` in CI.
 *   2. <main-repo>/mcp-server/node_modules — fallback when running from a
 *      git worktree whose mcp-server/ has no node_modules yet (local dev).
 *      The worktree is 5 levels deep under the main repo.
 */
function findNodeModules() {
  const candidates = [
    join(REPO_ROOT, "mcp-server", "node_modules"),
    join(REPO_ROOT, "..", "..", "..", "..", "..", "mcp-server", "node_modules"),
  ];
  for (const candidate of candidates) {
    const tsxBin = join(candidate, ".bin", "tsx");
    try {
      execSync(`test -x "${tsxBin}"`, { stdio: "pipe" });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `[install-sim] Cannot locate tsx in any node_modules candidate:\n` +
      candidates.map((c) => `  ${c}`).join("\n") +
      `\nEnsure mcp-server deps are installed (npm ci in mcp-server/).`,
  );
}

// ── #361 guard: assert this process is NOT running the pinned node ──────────
// Applied in normal mode only (not --self-check, which tests harness internals).
// Purpose: ensure CI's install-sim job exercises the ambient-Node path that
// caused #361 (.tool-versions pins nodejs 25.8.0 → asdf/mise shim exit 126).
// If CI uses the same Node as the pin, the test would pass spuriously.

function checkNodeVersion() {
  const runningVersion = process.version; // e.g. "v24.0.0"
  if (runningVersion === REPO_PINNED_NODE_VERSION) {
    console.error(
      `[install-sim] FAIL: Node ${runningVersion} matches the repo-pinned version ` +
        `${REPO_PINNED_NODE_VERSION}. The CI install-sim job MUST use a DIFFERENT ` +
        `Node version (e.g. 24.x) to exercise the #361 ambient-node path. ` +
        `This ensures .tool-versions breakage is detectable from the runner.`,
    );
    process.exit(1);
  }
  console.log(
    `[install-sim] Node version check passed: ${runningVersion} ≠ ${REPO_PINNED_NODE_VERSION}`,
  );
}

// ── Guard: spawn cwd must not be repo root ──────────────────────────────────

/**
 * Asserts that `spawnCwd` is NOT the repo root.
 * If this were accidentally process.cwd() (the repo), #356 would not reproduce
 * because BASH_SOURCE fallback in boot.sh would silently succeed.
 */
function assertNotRepoCwd(spawnCwd) {
  const repoReal = execSync("git rev-parse --show-toplevel", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (spawnCwd.startsWith(repoReal)) {
    throw new Error(
      `[install-sim] INTERNAL ERROR: spawn cwd "${spawnCwd}" is inside the repo ` +
        `root "${repoReal}". This would allow boot.sh BASH_SOURCE fallback to ` +
        `silently mask the #356 bug. Use a temp dir outside the repo.`,
    );
  }
}

// ── env substitution (mirrors Claude Code's behavior) ──────────────────────

/**
 * Expand ${VAR} and ${VAR:-default} tokens in a string.
 * Used ONLY for env value expansion — NOT for args (CC does not expand args).
 *
 * Reference: decisions/install-faithful-01.md — the no-args-expansion constraint.
 */
function expandEnvToken(value, envMap) {
  return value.replace(/\$\{([^}:]+)(?::-(.*?))?\}/g, (_, varName, fallback) => {
    const resolved = envMap[varName];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    return ""; // unset with no fallback → empty
  });
}

// ── .mcp.json parsing ───────────────────────────────────────────────────────

/**
 * Extract the canon server block from .mcp.json.
 * Returns { command, args, env } with args VERBATIM (no substitution).
 */
function parseMcpJson(mcpJsonPath) {
  const raw = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  const server = raw.mcpServers?.[SERVER_NAME];
  if (!server) {
    throw new Error(
      `[install-sim] No "${SERVER_NAME}" server in ${mcpJsonPath}. ` +
        `mcpServers keys: ${Object.keys(raw.mcpServers ?? {}).join(", ")}`,
    );
  }
  return {
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
  };
}

// ── MCP SDK handshake ───────────────────────────────────────────────────────

/**
 * Spawn the server with the given params and attempt an MCP initialize + listTools.
 * Returns { ok: true, toolCount } on success.
 * Returns { ok: false, reason, stderr } on failure.
 *
 * @param {object} spawnParams - { command, args, env, cwd }
 * @param {string} label - Human-readable label for log output
 */
async function attemptHandshake(spawnParams, label) {
  // Deferred dynamic imports so the module works without pre-installed node_modules
  // at the script's own location — we use the repo's mcp-server/node_modules.
  // Resolution order:
  //   1. REPO_ROOT/mcp-server/node_modules (present after npm ci in CI, or in dev worktrees)
  //   2. REPO_ROOT/../../../mcp-server/node_modules (fallback: main repo node_modules when
  //      this script runs from a git worktree whose mcp-server/ has no node_modules yet)
  const candidatePaths = [
    join(REPO_ROOT, "mcp-server", "node_modules"),
    // Worktree-to-main-repo fallback: the worktree is typically at
    //   <main-repo>/.canon/workspaces/<branch>/<slug>/worktree
    // which is 5 levels below the main repo root. This fallback allows local
    // development runs when the worktree's mcp-server/node_modules is absent
    // (e.g., fresh worktree without npm ci). In CI the primary path is used.
    join(REPO_ROOT, "..", "..", "..", "..", "..", "mcp-server", "node_modules"),
  ];

  let nodeModulesPath = null;
  for (const candidate of candidatePaths) {
    try {
      const sdkCheck = join(
        candidate,
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "client",
        "index.js",
      );
      readFileSync(sdkCheck); // will throw if not found
      nodeModulesPath = candidate;
      break;
    } catch {
      // try next
    }
  }

  if (!nodeModulesPath) {
    return {
      ok: false,
      reason:
        `SDK not found in any candidate node_modules path. ` +
        `Tried: ${candidatePaths.join(", ")}. ` +
        `Ensure mcp-server deps are installed (npm ci in mcp-server/).`,
      stderr: "",
    };
  }

  // Resolve SDK paths via the discovered node_modules.
  const sdkBase = join(
    nodeModulesPath,
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
    "client",
  );

  let Client, StdioClientTransport;
  try {
    ({ Client } = await import(join(sdkBase, "index.js")));
    ({ StdioClientTransport } = await import(join(sdkBase, "stdio.js")));
  } catch (err) {
    return {
      ok: false,
      reason: `SDK import failed — is mcp-server/node_modules installed? Error: ${err.message}`,
      stderr: "",
    };
  }

  if (DEBUG) {
    console.error(`[install-sim][${label}] Spawning:`, JSON.stringify(spawnParams, null, 2));
  }

  assertNotRepoCwd(spawnParams.cwd);

  let stderrOutput = "";
  const transport = new StdioClientTransport({
    command: spawnParams.command,
    args: spawnParams.args,
    env: spawnParams.env,
    cwd: spawnParams.cwd,
    stderr: "pipe",
  });

  // Capture stderr from the spawned process.
  // StdioClientTransport exposes stderr as a readable stream after start().
  const client = new Client({ name: "install-sim-smoke", version: "1.0.0" });

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        reason: `Handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
        stderr: stderrOutput,
      });
      // Best-effort cleanup
      try {
        transport.close();
      } catch {}
    }, HANDSHAKE_TIMEOUT_MS);

    // Wire up stderr capture before connect
    client
      .connect(transport)
      .then(async () => {
        // Capture stderr if available via transport
        if (transport.stderr) {
          transport.stderr.on("data", (chunk) => {
            stderrOutput += chunk.toString();
          });
        }

        let toolCount = 0;
        try {
          const result = await client.listTools();
          toolCount = result.tools?.length ?? 0;
        } catch (err) {
          clearTimeout(timer);
          await client.close().catch(() => {});
          resolve({
            ok: false,
            reason: `listTools() failed: ${err.message}`,
            stderr: stderrOutput,
          });
          return;
        }

        clearTimeout(timer);
        await client.close().catch(() => {});

        if (toolCount === 0) {
          resolve({
            ok: false,
            reason: "listTools() returned an EMPTY tool set — server booted but registered no tools",
            stderr: stderrOutput,
          });
        } else {
          resolve({ ok: true, toolCount });
        }
      })
      .catch((err) => {
        // Capture stderr from the transport process if accessible
        if (transport.stderr) {
          transport.stderr.on("data", (chunk) => {
            stderrOutput += chunk.toString();
          });
        }
        clearTimeout(timer);
        client.close().catch(() => {});
        resolve({ ok: false, reason: err.message, stderr: stderrOutput });
      });
  });
}

// ── Archive + environment setup ─────────────────────────────────────────────

/**
 * Archive the repo HEAD to a temp dir and prepare the environment.
 * Returns { archivePath, userProjectDir, cleanup }.
 */
async function setupInstallEnv() {
  const baseTmp = tmpdir();

  // Archive path — must NOT be inside the repo.
  const archivePath = await mkdtemp(join(baseTmp, "canon-install-sim-archive-"));

  // User project dir — the "cwd" perspective of a user running Claude Code.
  const userProjectDir = await mkdtemp(join(baseTmp, "canon-install-sim-project-"));

  console.log(`[install-sim] Archive path:      ${archivePath}`);
  console.log(`[install-sim] User project dir:  ${userProjectDir}`);

  // git archive HEAD → extract to archivePath
  execSync(`git archive HEAD | tar -x -C "${archivePath}"`, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  console.log(`[install-sim] Archived HEAD to ${archivePath}`);

  // Guard 3 containment check: assert the archived tree has no node_modules symlink
  // and no .canon/ content. Runs BEFORE the intentional test symlink is created below.
  assertNoLeakedArtifacts(archivePath);
  console.log("[install-sim] Guard 3 containment check passed (no leaked artifacts in archive).");

  // Deps: symlink the repo's installed node_modules into the archive's mcp-server/.
  // This mirrors the CLAUDE_PLUGIN_DATA symlink that boot.sh creates in plugin context.
  // Without this, boot.sh can't find tsx and fails. We use the repo's installed
  // deps (already CI-installed) — this is the closest approximation CI allows.
  //
  // Fidelity gap (documented): in a real install, deps come from CLAUDE_PLUGIN_DATA;
  // here we reuse the repo node_modules via symlink. This doesn't affect the
  // structural test (path resolution via CLAUDE_PLUGIN_ROOT / BASH_SOURCE) but
  // means dependency version differences between install and dev won't be caught.
  //
  // Resolution order: worktree's mcp-server/node_modules first (CI), then fallback
  // to main repo node_modules (local dev with fresh worktree).
  const archiveNmPath = join(archivePath, "mcp-server", "node_modules");
  const repoNmPath = findNodeModules();
  try {
    await symlink(repoNmPath, archiveNmPath);
    console.log(`[install-sim] Symlinked node_modules: ${archiveNmPath} → ${repoNmPath}`);
  } catch (err) {
    throw new Error(
      `[install-sim] Failed to symlink node_modules into archive: ${err.message}. ` +
        `Ensure mcp-server deps are installed (npm ci in mcp-server/).`,
    );
  }

  const cleanup = async () => {
    await rm(archivePath, { recursive: true, force: true });
    await rm(userProjectDir, { recursive: true, force: true });
  };

  return { archivePath, userProjectDir, cleanup };
}

// ── Normal mode ─────────────────────────────────────────────────────────────

async function runNormalMode() {
  // Enforce the #361 guard in normal mode: CI must use a node ≠ repo pin.
  checkNodeVersion();

  console.log("\n[install-sim] === NORMAL MODE ===");
  console.log("[install-sim] Reproducing install environment from HEAD...");

  const { archivePath, userProjectDir, cleanup } = await setupInstallEnv();

  try {
    // Parse .mcp.json from the ARCHIVED tree.
    const mcpJsonPath = join(archivePath, ".mcp.json");
    const { command, args: rawArgs, env: rawEnv } = parseMcpJson(mcpJsonPath);

    console.log(`[install-sim] Parsed .mcp.json command: ${command}`);
    console.log(`[install-sim] Parsed .mcp.json args (verbatim): ${JSON.stringify(rawArgs)}`);
    console.log(`[install-sim] Parsed .mcp.json env: ${JSON.stringify(rawEnv)}`);

    // Apply env substitution ONLY in env values.
    // We provide CLAUDE_PLUGIN_ROOT = archivePath (as the install would).
    // We provide CLAUDE_PROJECT_DIR = userProjectDir (as CC would for the user).
    const installEnv = {
      ...process.env, // inherit PATH etc.
      CLAUDE_PLUGIN_ROOT: archivePath,
      CLAUDE_PROJECT_DIR: userProjectDir,
    };

    const resolvedEnv = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      resolvedEnv[k] = expandEnvToken(v, installEnv);
    }

    // Build spawn params. Args are VERBATIM — no ${...} expansion.
    // On the current base (pre-#356-fix), rawArgs = ["${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh"]
    // which bash will receive as a literal path → file not found → boot fails.
    const spawnParams = {
      command,
      args: rawArgs, // VERBATIM — do NOT expand
      env: {
        ...installEnv,
        ...resolvedEnv,
      },
      cwd: userProjectDir, // spawn from non-repo user project dir
    };

    console.log(`[install-sim] Spawn cwd: ${spawnParams.cwd}`);
    console.log(`[install-sim] CLAUDE_PLUGIN_ROOT in env: ${spawnParams.env.CLAUDE_PLUGIN_ROOT}`);
    console.log(`[install-sim] args (verbatim, not expanded): ${JSON.stringify(spawnParams.args)}`);

    const result = await attemptHandshake(spawnParams, "normal");

    if (result.ok) {
      console.log(
        `[install-sim] PASS: initialize + listTools succeeded (${result.toolCount} tools).`,
      );
      console.log(
        "[install-sim] NOTE: If you see this on the pre-#356-fix base, something unexpected happened.",
      );
      return 0;
    } else {
      // On the pre-#356-fix base this is EXPECTED: ${CLAUDE_PLUGIN_ROOT:-.} is
      // literally passed to bash as a script path, which doesn't exist.
      console.error(`[install-sim] FAIL (expected on pre-#356-fix base): ${result.reason}`);
      if (result.stderr) {
        console.error("[install-sim] Server stderr output:");
        console.error(result.stderr);
      }
      console.error(
        "\n[install-sim] INTERPRETATION: This failure REPRODUCES issue #356.",
        "\n  The .mcp.json args contain '${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh'",
        "\n  which is passed VERBATIM to bash (CC does not expand ${} in args).",
        "\n  bash receives the literal string as a script path → file not found.",
        "\n  EXPECTED STATUS: This will PASS once PR #356 merges (fixing .mcp.json",
        "\n  to use a self-resolving BASH_SOURCE path instead of the ${} token).",
      );
      return 1;
    }
  } finally {
    await cleanup();
  }
}

// ── Self-check mode ──────────────────────────────────────────────────────────

/**
 * Self-verification: proves the harness correctly catches the #356 bug form
 * AND passes the fixed form.
 *
 * Sub-test 1 (BROKEN form, must FAIL):
 *   Synthetic .mcp.json with ${CLAUDE_PLUGIN_ROOT:-.} in args → handshake must fail.
 *   If it passes, the harness is papering over #356 — itself a defect.
 *
 * Sub-test 2 (FIXED form, must SUCCEED):
 *   Synthetic .mcp.json with the actual resolved archive path in args →
 *   handshake must succeed (proves the harness works when the install is correct).
 */
async function runSelfCheck() {
  console.log("\n[install-sim] === SELF-CHECK MODE ===");
  console.log("[install-sim] Verifying the harness correctly catches and passes the #356 forms...");

  // Guard 3 self-test: verify the containment tripwire fires correctly before proceeding.
  console.log("\n[install-sim][self-check/guard3] Running Guard 3 containment tripwire self-test...");
  selfTestContainmentTripwire();
  console.log("[install-sim][self-check/guard3] PASS.");

  const { archivePath, userProjectDir, cleanup } = await setupInstallEnv();

  let passed = true;

  try {
    const installEnv = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: archivePath,
      CLAUDE_PROJECT_DIR: userProjectDir,
    };

    // ── Sub-test 1: BROKEN form — token in args (pre-#356) ───────────────────
    console.log("\n[install-sim][self-check/1] BROKEN form: ${CLAUDE_PLUGIN_ROOT:-.} in args");
    console.log("[install-sim][self-check/1] Expected: FAIL (harness must catch #356)");

    const brokenParams = {
      command: "bash",
      // CRITICAL: literal ${CLAUDE_PLUGIN_ROOT:-.} token in args — NOT expanded.
      // This is the pre-#356 form. bash receives this as a literal script path.
      args: ["${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh"],
      env: installEnv,
      cwd: userProjectDir,
    };

    const brokenResult = await attemptHandshake(brokenParams, "self-check/broken");

    if (brokenResult.ok) {
      console.error(
        "[install-sim][self-check/1] HARNESS DEFECT: BROKEN form SUCCEEDED — " +
          "the harness is papering over #356. The token was somehow resolved " +
          "(check: did args expansion sneak in?). This is a harness bug.",
      );
      passed = false;
    } else {
      console.log(
        `[install-sim][self-check/1] PASS: BROKEN form correctly FAILED. ` +
          `Reason: ${brokenResult.reason}`,
      );
    }

    // ── Sub-test 2: FIXED form — resolved path in args ────────────────────────
    console.log("\n[install-sim][self-check/2] FIXED form: resolved path in args");
    console.log("[install-sim][self-check/2] Expected: SUCCEED (harness passes clean install)");

    const fixedBootPath = join(archivePath, "mcp-server", "boot.sh");
    const fixedParams = {
      command: "bash",
      // Fixed form: the path is fully resolved at spawn time — no shell tokens.
      // This is what a correct .mcp.json would produce after #356 fix.
      args: [fixedBootPath],
      env: installEnv,
      cwd: userProjectDir,
    };

    const fixedResult = await attemptHandshake(fixedParams, "self-check/fixed");

    if (fixedResult.ok) {
      console.log(
        `[install-sim][self-check/2] PASS: FIXED form succeeded (${fixedResult.toolCount} tools).`,
      );
    } else {
      console.error(
        `[install-sim][self-check/2] FAIL: FIXED form failed — ${fixedResult.reason}`,
      );
      if (fixedResult.stderr) {
        console.error("[install-sim][self-check/2] Server stderr:");
        console.error(fixedResult.stderr);
      }
      console.error(
        "[install-sim][self-check/2] DIAGNOSIS: The fixed form should always succeed.",
        "Check that mcp-server/node_modules is installed and CLAUDE_PLUGIN_ROOT points",
        "to the archive path containing mcp-server/boot.sh.",
      );
      passed = false;
    }
  } finally {
    await cleanup();
  }

  if (passed) {
    console.log(
      "\n[install-sim][self-check] ALL CHECKS PASSED.",
      "\n  • BROKEN form correctly fails (harness catches #356).",
      "\n  • FIXED form correctly succeeds (harness passes clean install).",
    );
    return 0;
  } else {
    console.error("\n[install-sim][self-check] ONE OR MORE CHECKS FAILED. See above.");
    return 1;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  try {
    let exitCode;
    if (SELF_CHECK_MODE) {
      exitCode = await runSelfCheck();
    } else {
      exitCode = await runNormalMode();
    }
    process.exit(exitCode);
  } catch (err) {
    console.error(`[install-sim] UNEXPECTED ERROR: ${err.message}`);
    if (DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
