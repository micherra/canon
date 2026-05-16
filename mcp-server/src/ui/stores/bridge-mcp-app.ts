/**
 * bridge-mcp-app.ts
 *
 * MCP App transport adapter for the Canon UI bridge.
 * Wraps the @modelcontextprotocol/ext-apps App class to implement the
 * BridgeAdapter interface, hiding all MCP App internals from components.
 *
 * Used when serving Svelte views inside the Claude MCP App iframe.
 */

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeAdapter, Decision } from "./bridge-types.ts";

// ── Private helpers (module-internal) ────────────────────────────────────────

function extractToolText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const c = result.content?.find((c) => c.type === "text");
  return c ? (c as { type: "text"; text: string }).text : "";
}

function extractToolJson(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = extractToolText(result);
  return text ? JSON.parse(text) : null;
}

type ParsedToolResult = { data: unknown } | { error: Error };

function parseToolResultParams(params: CallToolResult): ParsedToolResult {
  try {
    if (params.isError) {
      const errorText = extractToolText(params);
      return { error: new Error(errorText || "Tool returned an error") };
    }
    const parsed = extractToolJson(params);
    return { data: parsed };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

function dispatchToolResult(
  result: ParsedToolResult,
  resolve: ((data: unknown) => void) | null,
  reject: ((err: Error) => void) | null,
): void {
  if (resolve) {
    if ("error" in result) reject?.(result.error);
    else resolve(result.data);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an MCP App transport bridge adapter.
 *
 * Data flow: the MCP server pushes a tool result via the ontoolresult callback.
 * Components call loadData() which waits for that push (with early-buffering
 * in case the result arrives before loadData is called).
 *
 * @returns A BridgeAdapter implementation for MCP App transport.
 */
export function createMcpAppBridge(): BridgeAdapter {
  let app: App | null = null;

  /** Buffered early result (if ontoolresult fires before loadData is called). */
  let earlyResult: ParsedToolResult | null = null;
  /** Pending tool-result promise resolved by ontoolresult notification. */
  let toolResultResolve: ((data: unknown) => void) | null = null;
  let toolResultReject: ((err: Error) => void) | null = null;

  /** Wait for the host to deliver the tool result via ontoolresult notification. */
  function waitForToolResult(): Promise<unknown> {
    // If result arrived before this call, return it immediately.
    if (earlyResult) {
      const buffered = earlyResult;
      earlyResult = null;
      if ("error" in buffered) return Promise.reject(buffered.error);
      return Promise.resolve(buffered.data);
    }
    return new Promise((resolve, reject) => {
      toolResultResolve = resolve;
      toolResultReject = reject;
    });
  }

  return {
    async init(): Promise<void> {
      const instance = new App({ name: "Canon", version: "0.1.0" }, {}, { autoResize: true });

      instance.onhostcontextchanged = (ctx) => {
        if (ctx.theme) applyDocumentTheme(ctx.theme);
        if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
        if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
      };

      instance.ontoolresult = (params) => {
        const result = parseToolResultParams(params);
        if (toolResultResolve) {
          dispatchToolResult(result, toolResultResolve, toolResultReject);
          toolResultResolve = null;
          toolResultReject = null;
        } else {
          earlyResult = result;
        }
      };

      instance.onerror = console.error;

      await instance.connect();
      app = instance;

      // Apply initial host context.
      const ctx = instance.getHostContext();
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    },

    async loadData<T>(): Promise<T> {
      const result = await waitForToolResult();
      return result as T;
    },

    async sendMessage(text: string): Promise<void> {
      if (!app) throw new Error("Bridge not initialized");
      await app.sendMessage({
        content: [{ text, type: "text" }],
        role: "user",
      });
    },

    async submitDecision(decision: Decision): Promise<void> {
      // For MCP App, serialize decision as a user message.
      await this.sendMessage(JSON.stringify(decision));
    },
  };
}
