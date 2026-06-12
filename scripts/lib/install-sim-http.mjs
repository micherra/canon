#!/usr/bin/env node
/**
 * install-sim-http.mjs — HTTP handshake helpers for the install-sim smoke test.
 *
 * Handles: headersHelper ${...} resolution, running the helper script to get
 * the Authorization header, and connecting via StreamableHTTPClientTransport
 * to assert initialize + non-empty listTools.
 *
 * The headersHelper expansion logic mirrors how Claude Code expands ${...} in
 * the headersHelper field — this is the install-faithful pattern established
 * for env values (decisions/install-faithful-01.md), now extended to the
 * headersHelper path (probe-confirmed behavior, PROBE-FINDINGS.md §A, §C).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the headersHelper path by expanding ${VAR} / ${VAR:-default} tokens.
 *
 * CC expands ${...} in headersHelper empirically (PROBE-FINDINGS.md §A §2).
 * The harness mirrors this expansion so a literal unresolved token is the
 * failure mode the self-check BROKEN form deliberately exercises (Probe C).
 *
 * @param {string} headersHelperRaw - Raw headersHelper value from .mcp.json.
 * @param {Record<string, string>} envMap - Env map containing CLAUDE_PLUGIN_ROOT etc.
 * @param {(value: string, env: Record<string, string>) => string} expandFn
 *   - The shared expandEnvToken function from the parent module.
 * @returns {string} Resolved absolute (or cwd-relative) path to the helper script.
 */
export function resolveHeadersHelper(headersHelperRaw, envMap, expandFn) {
  return expandFn(headersHelperRaw, envMap);
}

/**
 * Run the headersHelper script and parse its JSON stdout.
 * The helper must emit {"Authorization":"Bearer <token>"} on stdout and exit 0.
 *
 * Fail-closed: any non-zero exit or non-parseable JSON → returns { ok: false }.
 * Never throws; callers treat { ok: false } as an absent Authorization header.
 *
 * @param {string} helperPath - Resolved path to the helper script.
 * @param {Record<string, string>} env - Env for the helper (must include CANON_MCP_TOKEN_FILE).
 * @param {string} [cwd] - Working directory for the helper; defaults to process.cwd().
 *   Pass `userProjectDir` to ensure relative paths (from :- fallback) resolve correctly.
 * @returns {{ ok: true, headers: Record<string, string> } | { ok: false, reason: string }}
 */
export function runHeadersHelper(helperPath, env, cwd) {
  try {
    const stdout = execFileSync("bash", [helperPath], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (err) {
      return {
        ok: false,
        reason: `headersHelper stdout is not valid JSON: ${err.message} (got: ${stdout.trim().slice(0, 80)})`,
      };
    }
    if (typeof parsed !== "object" || parsed === null || !parsed.Authorization) {
      return {
        ok: false,
        reason: `headersHelper JSON missing Authorization key (got: ${JSON.stringify(parsed)})`,
      };
    }
    return { ok: true, headers: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: `headersHelper script failed (exit non-zero or not found): ${err.message}`,
    };
  }
}

/**
 * Connect to the HTTP MCP daemon via StreamableHTTPClientTransport.
 *
 * Asserts: initialize() succeeds AND listTools() returns a non-empty set.
 * Bounded by HANDSHAKE_TIMEOUT_MS.
 *
 * SDK import path: dist/esm/client/streamableHttp.js — sibling of stdio.js.
 * The harness verifies the file exists at the discovered node_modules before
 * importing (assumption A4 from DESIGN.md).
 *
 * @param {{ url: string, headers: Record<string, string>, nodeModulesPath: string, timeoutMs: number }} params
 * @returns {Promise<{ ok: true, toolCount: number } | { ok: false, reason: string }>}
 */
export async function attemptHttpHandshake({ url, headers, nodeModulesPath, timeoutMs }) {
  const sdkBase = join(nodeModulesPath, "@modelcontextprotocol", "sdk", "dist", "esm", "client");

  // Verify the SDK HTTP transport file exists (assumption A4).
  const httpTransportPath = join(sdkBase, "streamableHttp.js");
  try {
    readFileSync(httpTransportPath);
  } catch {
    return {
      ok: false,
      reason:
        `SDK HTTP transport not found at ${httpTransportPath}. ` +
        `Ensure mcp-server deps are installed (npm ci in mcp-server/).`,
    };
  }

  let Client, StreamableHTTPClientTransport;
  try {
    ({ Client } = await import(join(sdkBase, "index.js")));
    ({ StreamableHTTPClientTransport } = await import(httpTransportPath));
  } catch (err) {
    return {
      ok: false,
      reason: `SDK import failed: ${err.message}`,
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const client = new Client({ name: "install-sim-smoke", version: "1.0.0" });

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        reason: `HTTP handshake timed out after ${timeoutMs}ms`,
      });
      try {
        transport.close();
      } catch {}
    }, timeoutMs);

    client
      .connect(transport)
      .then(async () => {
        let toolCount = 0;
        try {
          const result = await client.listTools();
          toolCount = result.tools?.length ?? 0;
        } catch (err) {
          clearTimeout(timer);
          await client.close().catch(() => {});
          resolve({ ok: false, reason: `listTools() failed: ${err.message}` });
          return;
        }
        clearTimeout(timer);
        await client.close().catch(() => {});
        if (toolCount === 0) {
          resolve({
            ok: false,
            reason: "listTools() returned an EMPTY tool set — server booted but registered no tools",
          });
        } else {
          resolve({ ok: true, toolCount });
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        client.close().catch(() => {});
        resolve({ ok: false, reason: err.message });
      });
  });
}
