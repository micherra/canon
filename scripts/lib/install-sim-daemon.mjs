#!/usr/bin/env node
/**
 * install-sim-daemon.mjs — Daemon lifecycle for the install-sim smoke test.
 *
 * Handles: spawning boot.sh --daemon on a test port with a throwaway token,
 * polling /health until ready, and tearing the daemon down after the test.
 *
 * All functions emit progress to stderr (observable-best-effort).
 */

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Pick an ephemeral port by binding to 0, reading the assigned port, then
 * releasing the socket. MUST differ from 3142 (the production default) so
 * the run exercises the CANON_DAEMON_PORT expansion path.
 *
 * @returns {Promise<number>} A free OS-assigned port number.
 */
export async function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("[install-sim] pickEphemeralPort: could not read assigned port"));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        if (port === 3142) {
          // Extremely unlikely but guard against it — retry once.
          pickEphemeralPort().then(resolve).catch(reject);
        } else {
          resolve(port);
        }
      });
    });
    srv.on("error", reject);
  });
}

/**
 * Create a temporary directory for the daemon's pid and token files.
 * Caller must delete it in their finally block.
 *
 * @returns {Promise<string>} Path to a fresh temp dir.
 */
export async function makeDaemonTempDir() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "canon-test-daemon-"));
}

/**
 * Start the Canon HTTP daemon using boot.sh --daemon.
 *
 * The daemon is started from `userProjectDir` (a non-repo temp dir — satisfies
 * the #361 assertNotRepoCwd discipline). `CANON_HTTP_DAEMON=1` tells daemon.ts
 * to bind HTTP instead of stdio. `CANON_DAEMON_PORT` routes it to the ephemeral
 * test port. `CANON_MCP_TOKEN_FILE` points to a throwaway token path in a temp
 * dir — auth.ts creates it on first use (0600, 64-hex) without touching the real
 * ~/.claude token.
 *
 * @param {{ archivePath: string, userProjectDir: string, port: number, tokenFile: string }} params
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, stdoutLines: string[], stderrLines: string[] }>}
 */
export async function startTestDaemon({ archivePath, userProjectDir, port, tokenFile }) {
  const bootScript = join(archivePath, "mcp-server", "boot.sh");
  const daemonEnv = {
    ...process.env,
    CANON_HTTP_DAEMON: "1",
    CANON_DAEMON_PORT: String(port),
    CANON_MCP_TOKEN_FILE: tokenFile,
    CLAUDE_PLUGIN_ROOT: archivePath,
    CLAUDE_PROJECT_DIR: userProjectDir,
  };

  console.error(
    `[install-sim] Starting daemon: bash ${bootScript} --daemon (port=${port}, cwd=${userProjectDir})`,
  );

  const stdoutLines = [];
  const stderrLines = [];

  const proc = spawn("bash", [bootScript, "--daemon"], {
    cwd: userProjectDir,
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    stdoutLines.push(...lines);
    for (const line of lines) {
      console.error(`[install-sim][daemon/stdout] ${line}`);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    stderrLines.push(...lines);
    for (const line of lines) {
      console.error(`[install-sim][daemon/stderr] ${line}`);
    }
  });

  proc.on("error", (err) => {
    console.error(`[install-sim] Daemon spawn error: ${err.message}`);
  });

  return { proc, stdoutLines, stderrLines };
}

/**
 * Poll GET /health on the given port until {ok: true} or timeout.
 * Never uses sleep N — uses bounded retries with Promise-based delay.
 *
 * @param {number} port
 * @param {{ timeoutMs?: number, intervalMs?: number }} opts
 * @returns {Promise<void>} Resolves when healthy; rejects on timeout.
 */
export async function waitForHealth(port, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  // Sequential retry loop — each iteration waits for the previous fetch to
  // complete before scheduling the next delay. This is intentional: we are
  // serializing health probes, not doing independent concurrent work.
  // noAwaitInLoops does not apply here because each iteration's await is
  // causally dependent on the previous one (it IS the retry loop).
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok === true) {
          console.error(`[install-sim] Daemon healthy after ${attempts} probe(s) on :${port}`);
          return;
        }
      }
    } catch {
      // Connection refused or parse error — daemon not ready yet
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }

  throw new Error(
    `[install-sim] Daemon on :${port} not healthy after ${timeoutMs}ms (${attempts} probes). ` +
      `Check daemon stderr output above for startup errors.`,
  );
}

/**
 * Tear down the test daemon and confirm the port was released.
 *
 * Sends SIGTERM; re-probes /health after a brief settle window.
 * Logs a WARNING (does NOT throw) if the port lingers — but reports
 * the leak in the returned result so callers can decide to fail.
 *
 * @param {import('node:child_process').ChildProcess} proc
 * @param {number} port
 * @returns {Promise<{ ok: boolean, portLeaked: boolean }>}
 */
export async function teardownDaemon(proc, port) {
  console.error(`[install-sim] Tearing down daemon (pid=${proc.pid}, port=${port})`);
  try {
    proc.kill("SIGTERM");
  } catch (err) {
    console.error(`[install-sim] WARNING: SIGTERM failed: ${err.message}`);
  }

  // Wait for process to exit.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });

  // Confirm the port was released.
  const url = `http://127.0.0.1:${port}/health`;
  let portLeaked = false;
  try {
    const res = await fetch(url);
    if (res.ok) {
      console.error(
        `[install-sim] WARNING: Port ${port} still responds after SIGTERM. Port may be leaked.`,
      );
      portLeaked = true;
    }
  } catch {
    // Expected: connection refused → port released cleanly.
    console.error(`[install-sim] Port ${port} released (connection refused as expected).`);
  }

  return { ok: !portLeaked, portLeaked };
}

/**
 * Write an empty placeholder token file at the given path.
 * boot.sh's CANON_MCP_TOKEN_FILE is created by daemon auth.ts on startup
 * (loadOrCreateToken). We pre-create the parent dir via this helper so the
 * temp path is guaranteed to be writable before the daemon starts.
 *
 * @param {string} tokenFile - Absolute path for the throwaway token.
 */
export async function prepareTokenFile(tokenFile) {
  // Write an empty file so the path resolves to a known writable location.
  // auth.ts will overwrite it with a 64-hex token on startup.
  await writeFile(tokenFile, "", { mode: 0o600 });
}

/**
 * Remove the daemon temp dir (tokenFile + any pid files) on teardown.
 * Call in the finally block of the test harness.
 *
 * @param {string} tmpDir - Directory returned by makeDaemonTempDir().
 */
export async function cleanupDaemonTempDir(tmpDir) {
  await rm(tmpDir, { recursive: true, force: true });
}
