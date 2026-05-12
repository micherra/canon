/**
 * bridge-http.ts
 *
 * HTTP transport adapter for the Canon UI bridge.
 * Reads initial data from window.__CANON_DATA__ (injected by the HTTP server)
 * and submits decisions via fetch() POST to window.__CANON_ARTIFACT_URL__.
 *
 * Used when serving Svelte views as standalone HTML pages from the Canon HTTP
 * server, as opposed to inside the MCP App iframe.
 */

import type { BridgeAdapter, Decision } from "./bridge-types.ts";

/** Extended global type for Canon-injected page data. */
type CanonGlobal = typeof globalThis & {
  __CANON_DATA__?: unknown;
  __CANON_ARTIFACT_URL__?: string;
};

/** Type-safe accessor for Canon globals that works in both browser and Node (tests). */
const g = globalThis as CanonGlobal;

/**
 * Creates an HTTP transport bridge adapter.
 *
 * Data flow: HTTP server injects window.__CANON_DATA__ and
 * window.__CANON_ARTIFACT_URL__ into the served HTML page at render time.
 * Components call loadData() to read the payload and submitDecision() to
 * POST the user's decision back to the server.
 *
 * @returns A BridgeAdapter implementation for HTTP transport.
 */
export function createHttpBridge(): BridgeAdapter {
  return {
    async init() {
      // No-op for HTTP — data is already embedded in the page at render time.
    },

    async loadData<T>(): Promise<T> {
      const data = g.__CANON_DATA__;
      if (!data) {
        throw new Error("No embedded data found (window.__CANON_DATA__ is undefined)");
      }
      return data as T;
    },

    async sendMessage(text: string): Promise<void> {
      // HTTP bridge does not support sendMessage — annotations go through submitDecision.
      // Log to stderr-equivalent (console.warn) per the plan's constraint: never stdout.
      console.warn("sendMessage is not supported in HTTP bridge mode:", text);
    },

    async submitDecision(decision: Decision): Promise<void> {
      const url = g.__CANON_ARTIFACT_URL__;
      if (!url) {
        throw new Error("No artifact URL found (window.__CANON_ARTIFACT_URL__ is undefined)");
      }
      const response = await fetch(`${url}/decision`, {
        body: JSON.stringify(decision),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Decision submission failed: ${response.status}`);
      }
    },
  };
}
