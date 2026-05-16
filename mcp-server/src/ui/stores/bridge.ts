/**
 * bridge.ts
 *
 * Transport factory — auto-detects the active transport and returns a
 * singleton BridgeAdapter instance for Svelte components to consume.
 *
 * Transport detection:
 *   - HTTP: window.__CANON_DATA__ is defined (injected by the HTTP server)
 *   - MCP App: window.__CANON_DATA__ is undefined (running inside Claude MCP App iframe)
 *
 * Components import { bridge } and call bridge.init(), bridge.loadData<T>(),
 * bridge.submitDecision(), and bridge.sendMessage() without knowing which
 * transport is active.
 */

import { createHttpBridge } from "./bridge-http.ts";
import { createMcpAppBridge } from "./bridge-mcp-app.ts";
import type { BridgeAdapter } from "./bridge-types.ts";

/** Detect which transport is active at page load time. */
function detectTransport(): "http" | "mcp-app" {
  if ((globalThis as Record<string, unknown>).__CANON_DATA__ !== undefined) {
    return "http";
  }
  return "mcp-app";
}

/**
 * Create the appropriate bridge adapter for the detected transport.
 * @returns A BridgeAdapter instance for the active transport.
 */
function createBridge(): BridgeAdapter {
  const transport = detectTransport();
  return transport === "http" ? createHttpBridge() : createMcpAppBridge();
}

/** Singleton bridge instance — transport auto-detected at module load time. */
export const bridge = createBridge();
