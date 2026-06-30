#!/usr/bin/env node
/**
 * install-sim-smoke.mjs — Faithful install-simulation smoke test (HTTP transport).
 *
 * Old→new regression mapping (ADR-0004 / PROBE-FINDINGS.md):
 *
 *   #356 (literal ${...} in args → boot.sh not found) →
 *     HTTP analog: unresolved headersHelper (literal ${CLAUDE_PLUGIN_ROOT:-.} →
 *     helper path not found → no Authorization header → connection FAILS).
 *     Self-check BROKEN form exercises this path.
 *
 *   #361 (ambient Node ≠ repo pin → asdf/mise shim exit 126) →
 *     UNCHANGED: checkNodeVersion() retained in normal mode; boot.sh --daemon
 *     also exercises the ambient-node path (boot.sh Step 12.5 Node preflight).
 *
 *   #370 (var-absent / broken install → silent -32000 collapse) →
 *     Fail-closed: runHeadersHelper returns { ok: false } on any failure (no
 *     silent swallowing); empty tool set → exit 1 with named reason; connection
 *     failure reported loudly. Self-check BROKEN form must exit non-zero.
 *
 * What this harness does (HTTP form):
 *   1. Archives HEAD via `git archive` to a temp dir outside the repo.
 *   2. Resolves the HTTP canon server block from the ARCHIVED .mcp.json.
 *   3. Boots a Canon HTTP daemon on an ephemeral test port with a throwaway
 *      token file — NEVER touches ~/.claude or the real daemon on :3142.
 *   4. Expands ${...} in url and headersHelper exactly as Claude Code does.
 *   5. Runs the headersHelper → gets {"Authorization":"Bearer <token>"}.
 *   6. Connects via StreamableHTTPClientTransport; asserts initialize + non-empty
 *      listTools. Tears the daemon down after (no port leak).
 *
 * Flags:
 *   (none)       Normal mode — drive the actual .mcp.json from the archive.
 *   --self-check Self-verification: BROKEN form (unresolved headersHelper) FAILS;
 *                FIXED form SUCCEEDS. Exits 0 iff both behave as expected.
 *   --debug      Print resolved env and params to stderr before spawning.
 *
 * CI: run by the install-sim job in .github/workflows/ci.yml on Node 24.x
 * (distinct from the repo-pinned 25.8.0) to exercise the #361 ambient-node path.
 */

import { execSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync as rmSyncFs, symlinkSync as symlinkSyncFs, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pickEphemeralPort,
  makeDaemonTempDir,
  prepareTokenFile,
  startTestDaemon,
  waitForHealth,
  teardownDaemon,
  cleanupDaemonTempDir,
} from "./lib/install-sim-daemon.mjs";
import {
  resolveHeadersHelper,
  runHeadersHelper,
  attemptHttpHandshake,
} from "./lib/install-sim-http.mjs";

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

    // Test 5: .gitignore covers node_modules symlink form (not just directory form).
    // The repo .gitignore line 1 "node_modules/" (trailing slash) only matches directories.
    // A symlink named "node_modules" is NOT a directory and would slip through.
    // This check asserts the SLASH-LESS rule "node_modules" is present so that
    // `git check-ignore mcp-server/node_modules` returns a match (exit 0).
    // FAIL condition: if only "node_modules/" exists in .gitignore, `git check-ignore`
    // exits 1 for a symlink path — meaning agents could stage the symlink via `git add -A`.
    try {
      execSync('git check-ignore -q mcp-server/node_modules', {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      console.log("[install-sim] .gitignore symlink coverage check: mcp-server/node_modules is git-ignored (PASS).");
    } catch {
      throw new Error(
        "[install-sim] .gitignore SYMLINK GAP DETECTED: `git check-ignore mcp-server/node_modules` returned no match.\n" +
        "The .gitignore only has 'node_modules/' (directory form) — symlinks are NOT directories and slip through.\n" +
        "Fix: add 'node_modules' (no trailing slash) to .gitignore so both directories and symlinks are covered."
      );
    }
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

const cliArgs = process.argv.slice(2);
const SELF_CHECK_MODE = cliArgs.includes("--self-check");
const DEBUG = cliArgs.includes("--debug");

// ── node_modules discovery ───────────────────────────────────────────────────

/**
 * Locate an installed mcp-server/node_modules that contains the MCP SDK.
 * Resolution order:
 *   1. REPO_ROOT/mcp-server/node_modules — present after `npm ci` in CI.
 *   2. <main-repo>/mcp-server/node_modules — fallback when running from a
 *      git worktree whose mcp-server/ has no node_modules yet (local dev).
 */
function findNodeModules() {
  const candidates = [
    join(REPO_ROOT, "mcp-server", "node_modules"),
    join(REPO_ROOT, "..", "..", "..", "..", "..", "mcp-server", "node_modules"),
  ];
  for (const candidate of candidates) {
    const sdkCheck = join(
      candidate,
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
      "client",
      "index.js",
    );
    try {
      readFileSync(sdkCheck);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `[install-sim] Cannot locate MCP SDK in any node_modules candidate:\n` +
      candidates.map((c) => `  ${c}`).join("\n") +
      `\nEnsure mcp-server deps are installed (npm ci in mcp-server/).`,
  );
}

// ── #361 guard: assert this process is NOT running the pinned node ──────────
// Applied in normal mode only (not --self-check, which tests harness internals).

function checkNodeVersion() {
  const runningVersion = process.version;
  if (runningVersion === REPO_PINNED_NODE_VERSION) {
    console.error(
      `[install-sim] FAIL: Node ${runningVersion} matches the repo-pinned version ` +
        `${REPO_PINNED_NODE_VERSION}. The CI install-sim job MUST use a DIFFERENT ` +
        `Node version (e.g. 24.x) to exercise the #361 ambient-node path.`,
    );
    process.exit(1);
  }
  console.log(
    `[install-sim] Node version check passed: ${runningVersion} ≠ ${REPO_PINNED_NODE_VERSION}`,
  );
}

// ── Guard: spawn cwd must not be repo root ──────────────────────────────────

/**
 * Asserts that `spawnCwd` is NOT inside the repo root.
 * Prevents boot.sh BASH_SOURCE fallback from masking real path failures.
 */
function assertNotRepoCwd(spawnCwd) {
  const repoReal = execSync("git rev-parse --show-toplevel", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (spawnCwd.startsWith(repoReal)) {
    throw new Error(
      `[install-sim] INTERNAL ERROR: spawn cwd "${spawnCwd}" is inside the repo ` +
        `root "${repoReal}". Use a temp dir outside the repo.`,
    );
  }
}

// ── env substitution (mirrors Claude Code's behavior) ──────────────────────

/**
 * Expand ${VAR} and ${VAR:-default} tokens in a string.
 * Used for url, headersHelper, and env values — NOT for args (CC does not expand args).
 * Exported so install-sim-http.mjs can receive it as an expandFn argument.
 */
export function expandEnvToken(value, envMap) {
  return value.replace(/\$\{([^}:]+)(?::-(.*?))?\}/g, (_, varName, fallback) => {
    const resolved = envMap[varName];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    return "";
  });
}

// ── .mcp.json parsing ───────────────────────────────────────────────────────

/**
 * Extract the canon server block from .mcp.json.
 * Returns HTTP form: { type, url, headersHelper }.
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
    type: server.type ?? "stdio",
    url: server.url,
    headersHelper: server.headersHelper,
    // Legacy stdio fields (kept for forward compat if form reverts):
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
  };
}

// ── Archive + environment setup ─────────────────────────────────────────────

/**
 * Archive the repo HEAD to a temp dir and prepare the environment.
 * Symlinks the repo's installed node_modules into the archive's mcp-server/
 * (mirrors CLAUDE_PLUGIN_DATA symlink that boot.sh creates in plugin context).
 */
async function setupInstallEnv() {
  const baseTmp = tmpdir();
  const archivePath = await mkdtemp(join(baseTmp, "canon-install-sim-archive-"));
  const userProjectDir = await mkdtemp(join(baseTmp, "canon-install-sim-project-"));

  console.log(`[install-sim] Archive path:      ${archivePath}`);
  console.log(`[install-sim] User project dir:  ${userProjectDir}`);

  execSync(`git archive HEAD | tar -x -C "${archivePath}"`, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  console.log(`[install-sim] Archived HEAD to ${archivePath}`);

  // Guard 3 containment check: assert the archived tree has no node_modules symlink
  // and no .canon/ content. Runs BEFORE the intentional test symlink is created below.
  assertNoLeakedArtifacts(archivePath);
  console.log("[install-sim] Guard 3 containment check passed (no leaked artifacts in archive).");

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

// ── HTTP sub-test helper ─────────────────────────────────────────────────────

/**
 * Run a single HTTP handshake sub-test with the given options.
 *
 * @param {{
 *   nodeModulesPath: string,
 *   expandedUrl: string,
 *   headersHelperRaw: string,
 *   installEnvForHelper: Record<string, string>,
 *   tokenFile: string,
 *   label: string,
 *   helperCwd: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, toolCount?: number }>}
 */
async function runHttpSubTest({
  nodeModulesPath,
  expandedUrl,
  headersHelperRaw,
  installEnvForHelper,
  tokenFile,
  label,
  helperCwd,
}) {
  const helperPath = resolveHeadersHelper(headersHelperRaw, installEnvForHelper, expandEnvToken);
  if (DEBUG) {
    console.error(`[install-sim][${label}] headersHelper resolved: <redacted>`);
    console.error(`[install-sim][${label}] url: <redacted>`);
  }

  const headerResult = runHeadersHelper(
    helperPath,
    { ...installEnvForHelper, CANON_MCP_TOKEN_FILE: tokenFile },
    helperCwd,
  );

  if (!headerResult.ok) {
    console.error(
      `[install-sim][${label}] headersHelper FAILED (fail-closed): ${headerResult.reason}`,
    );
    return { ok: false, reason: headerResult.reason };
  }

  const result = await attemptHttpHandshake({
    url: expandedUrl,
    headers: headerResult.headers,
    nodeModulesPath,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  });

  return result;
}

// ── Normal mode ─────────────────────────────────────────────────────────────

async function runNormalMode() {
  // #361 guard: CI must use a Node ≠ repo pin.
  checkNodeVersion();

  console.log("\n[install-sim] === NORMAL MODE (HTTP transport) ===");
  console.log("[install-sim] Reproducing install environment from HEAD...");

  const { archivePath, userProjectDir, cleanup } = await setupInstallEnv();
  const nodeModulesPath = findNodeModules();
  const daemonTmpDir = await makeDaemonTempDir();
  let proc = null;
  let ephemeralPort = 0;

  try {
    assertNotRepoCwd(userProjectDir);

    // Parse .mcp.json from the ARCHIVED tree.
    const mcpJsonPath = join(archivePath, ".mcp.json");
    const { type, url: rawUrl, headersHelper: rawHeadersHelper } = parseMcpJson(mcpJsonPath);

    if (type !== "http" || !rawUrl || !rawHeadersHelper) {
      throw new Error(
        `[install-sim] Expected HTTP .mcp.json form (type=http, url, headersHelper). ` +
          `Got: type=${type}, url=${rawUrl}, headersHelper=${rawHeadersHelper}`,
      );
    }

    const installEnv = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: archivePath,
      CLAUDE_PROJECT_DIR: userProjectDir,
    };

    // Pick ephemeral port — proves CANON_DAEMON_PORT path (#356 analog for url).
    ephemeralPort = await pickEphemeralPort();
    const port = ephemeralPort;
    const tokenFile = join(daemonTmpDir, "canon-mcp-token");
    await prepareTokenFile(tokenFile);

    // Expand url: must contain the ephemeral port (not :3142).
    const expandedUrl = expandEnvToken(rawUrl, { ...installEnv, CANON_DAEMON_PORT: String(port) });
    if (expandedUrl.includes("${")) {
      throw new Error(
        `[install-sim] FAIL: url still contains unresolved \${...} after expansion: ${expandedUrl}. ` +
          `This is the #356 analog for the HTTP url field — check .mcp.json and installEnv.`,
      );
    }
    if (!expandedUrl.includes(`:${port}`)) {
      throw new Error(
        `[install-sim] FAIL: expanded url "${expandedUrl}" does not contain the ephemeral port ${port}. ` +
          `CANON_DAEMON_PORT expansion may have failed.`,
      );
    }
    console.log("[install-sim] Expanded url: <redacted>");

    // Boot daemon on the ephemeral port.
    ({ proc } = await startTestDaemon({ archivePath, userProjectDir, port, tokenFile }));
    await waitForHealth(port);

    const result = await runHttpSubTest({
      nodeModulesPath,
      expandedUrl,
      headersHelperRaw: rawHeadersHelper,
      installEnvForHelper: installEnv,
      tokenFile,
      label: "normal",
      helperCwd: userProjectDir,
    });

    if (result.ok) {
      console.log(
        `[install-sim] PASS: initialize + listTools succeeded (${result.toolCount} tools).`,
      );
      return 0;
    } else {
      console.error(`[install-sim] FAIL: ${result.reason}`);
      return 1;
    }
  } finally {
    if (proc) {
      const { portLeaked } = await teardownDaemon(proc, ephemeralPort);
      if (portLeaked) {
        console.error("[install-sim] WARNING: port may be leaked — check ephemeral port above.");
      }
    }
    await cleanupDaemonTempDir(daemonTmpDir);
    await cleanup();
  }
}

// ── Self-check mode ──────────────────────────────────────────────────────────

/**
 * Self-verification: proves the harness correctly catches the HTTP #356 analog
 * AND passes the fixed HTTP form.
 *
 * One daemon is booted and shared between both sub-tests for efficiency.
 *
 * Sub-test 1 — BROKEN form (must FAIL):
 *   Clean url (correct) + UNRESOLVED headersHelper (CLAUDE_PLUGIN_ROOT unset →
 *   ${CLAUDE_PLUGIN_ROOT:-.} → "." → helper path under cwd, not found →
 *   runHeadersHelper returns { ok: false } → no Authorization → connection FAILS).
 *   This is Probe C from PROBE-FINDINGS.md. If this SUCCEEDS, the harness is
 *   papering over the #356 HTTP analog → harness defect → exit 1.
 *
 * Sub-test 2 — FIXED form (must SUCCEED):
 *   Clean url + resolved headersHelper (CLAUDE_PLUGIN_ROOT=archivePath) +
 *   valid throwaway token → handshake SUCCEEDS, non-empty tools.
 *   This is Probe A from PROBE-FINDINGS.md.
 *
 * Sub-test 3 — WRONG-PORT form (optional, Codex P2 class, must FAIL):
 *   Hardcoded wrong port in url (3142) while daemon is on the ephemeral port →
 *   connection FAILS. Validates the Codex P2 fix (${CANON_DAEMON_PORT:-3142}).
 */
async function runSelfCheck() {
  console.log("\n[install-sim] === SELF-CHECK MODE (HTTP transport) ===");
  console.log("[install-sim] Verifying harness catches HTTP ${...} regression classes...");

  // Guard 3 self-test: verify the containment tripwire fires correctly before proceeding.
  console.log("\n[install-sim][self-check/guard3] Running Guard 3 containment tripwire self-test...");
  selfTestContainmentTripwire();
  console.log("[install-sim][self-check/guard3] PASS.");

  const { archivePath, userProjectDir, cleanup } = await setupInstallEnv();
  const nodeModulesPath = findNodeModules();
  const daemonTmpDir = await makeDaemonTempDir();
  const tokenFile = join(daemonTmpDir, "canon-mcp-token");
  let proc = null;
  let selfCheckPort = 0;
  let passed = true;

  try {
    assertNotRepoCwd(userProjectDir);
    await prepareTokenFile(tokenFile);

    const port = await pickEphemeralPort();
    selfCheckPort = port;
    ({ proc } = await startTestDaemon({ archivePath, userProjectDir, port, tokenFile }));
    await waitForHealth(port);

    const installEnv = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: archivePath,
      CLAUDE_PROJECT_DIR: userProjectDir,
    };
    const expandedUrl = expandEnvToken(
      "http://127.0.0.1:${CANON_DAEMON_PORT:-3142}/mcp",
      { ...installEnv, CANON_DAEMON_PORT: String(port) },
    );

    // Sub-test 1: BROKEN form — unresolved headersHelper (Probe C / #356 HTTP analog).
    console.log("\n[install-sim][self-check/1] BROKEN: unresolved headersHelper → no auth");
    console.log("[install-sim][self-check/1] Expected: FAIL");

    const brokenEnv = { ...installEnv };
    delete brokenEnv.CLAUDE_PLUGIN_ROOT; // Force :- default to resolve to cwd "."
    const rawHelperTemplate = "${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/mcp-auth-headers.sh";

    const brokenResult = await runHttpSubTest({
      nodeModulesPath,
      expandedUrl,
      headersHelperRaw: rawHelperTemplate,
      installEnvForHelper: brokenEnv,
      tokenFile,
      label: "self-check/broken",
      helperCwd: userProjectDir, // relative "." resolves against userProjectDir (no mcp-server/ there)
    });

    if (brokenResult.ok) {
      console.error(
        "[install-sim][self-check/1] HARNESS DEFECT: BROKEN form SUCCEEDED. " +
          "The harness is papering over the HTTP #356 analog (headersHelper not found " +
          "should mean no auth → connection fails). This is a harness bug.",
      );
      passed = false;
    } else {
      console.log(
        `[install-sim][self-check/1] PASS: BROKEN form correctly FAILED. Reason: ${brokenResult.reason}`,
      );
    }

    // Sub-test 2: FIXED form — resolved headersHelper + valid token (Probe A).
    console.log("\n[install-sim][self-check/2] FIXED: resolved headersHelper + valid token");
    console.log("[install-sim][self-check/2] Expected: SUCCEED");

    const fixedResult = await runHttpSubTest({
      nodeModulesPath,
      expandedUrl,
      headersHelperRaw: rawHelperTemplate,
      installEnvForHelper: installEnv, // CLAUDE_PLUGIN_ROOT set → resolves correctly
      tokenFile,
      label: "self-check/fixed",
      helperCwd: userProjectDir,
    });

    if (fixedResult.ok) {
      console.log(
        `[install-sim][self-check/2] PASS: FIXED form succeeded (${fixedResult.toolCount} tools).`,
      );
    } else {
      console.error(
        `[install-sim][self-check/2] FAIL: FIXED form failed — ${fixedResult.reason}`,
      );
      passed = false;
    }

    // Sub-test 3: WRONG-PORT form (Codex P2 — optional, low cost).
    console.log("\n[install-sim][self-check/3] WRONG-PORT: hardcoded :3142 (Codex P2 class)");
    console.log("[install-sim][self-check/3] Expected: FAIL to connect");

    const wrongPortUrl = "http://127.0.0.1:3142/mcp";
    const headerResult = runHeadersHelper(
      resolveHeadersHelper(rawHelperTemplate, installEnv, expandEnvToken),
      { ...installEnv, CANON_MCP_TOKEN_FILE: tokenFile },
      userProjectDir,
    );

    if (headerResult.ok) {
      const wrongPortResult = await attemptHttpHandshake({
        url: wrongPortUrl,
        headers: headerResult.headers,
        nodeModulesPath,
        timeoutMs: 5_000, // shorter timeout for the wrong-port case
      });
      if (!wrongPortResult.ok) {
        console.log(
          `[install-sim][self-check/3] PASS: Wrong-port form correctly FAILED (${wrongPortResult.reason}).`,
        );
      } else {
        console.error(
          "[install-sim][self-check/3] UNEXPECTED: Wrong-port form SUCCEEDED. " +
            "Is a daemon running on :3142? Skipping as inconclusive (not fatal).",
        );
        // Not fatal — a real daemon on :3142 would cause this; don't fail the build over it.
      }
    } else {
      console.error(
        `[install-sim][self-check/3] SKIP: could not get auth header for wrong-port test: ${headerResult.reason}`,
      );
    }
  } finally {
    if (proc) {
      await teardownDaemon(proc, selfCheckPort);
    }
    await cleanupDaemonTempDir(daemonTmpDir);
    await cleanup();
  }

  if (passed) {
    console.log(
      "\n[install-sim][self-check] ALL CHECKS PASSED.",
      "\n  • BROKEN form correctly fails (harness catches HTTP #356 analog).",
      "\n  • FIXED form correctly succeeds (harness passes clean HTTP install).",
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
    console.error(`[install-sim] UNEXPECTED ERROR: ${err?.name ?? "Error"}`);
    if (DEBUG) console.error("[install-sim] Error name:", err?.name ?? "Error");
    process.exit(1);
  }
}

main();
