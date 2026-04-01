import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

let app: App | null = null;

function extractToolText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const c = result.content?.find((c) => c.type === "text");
  return c ? (c as { type: "text"; text: string }).text : "";
}

function extractToolJson(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = extractToolText(result);
  return text ? JSON.parse(text) : null;
}

/** Buffered early result (if ontoolresult fires before waitForToolResult is called). */
let earlyResult: { data: unknown } | { error: Error } | null = null;
/** Pending tool-result promise resolved by ontoolresult notification. */
let toolResultResolve: ((data: unknown) => void) | null = null;
let toolResultReject: ((err: Error) => void) | null = null;

export const bridge = {
  async init() {
    const instance = new App({ name: "Canon", version: "0.1.0" }, {}, { autoResize: true });

    instance.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };

    instance.ontoolresult = (params) => {
      let parsed: unknown;
      let parseError: Error | null = null;
      try {
        parsed = params.isError
          ? null
          : extractToolJson(params as unknown as { content?: Array<{ type: string; text?: string }> });
      } catch (e) {
        parseError = e instanceof Error ? e : new Error(String(e));
      }

      if (toolResultResolve) {
        if (parseError) toolResultReject?.(parseError);
        else toolResultResolve(parsed);
        toolResultResolve = null;
        toolResultReject = null;
      } else {
        // Buffer for later waitForToolResult() call
        earlyResult = parseError ? { error: parseError } : { data: parsed };
      }
    };

    instance.onerror = console.error;

    await instance.connect();
    app = instance;

    // Apply initial host context
    const ctx = instance.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  },

  /** Wait for the host to deliver the tool result via ontoolresult notification. */
  waitForToolResult(): Promise<unknown> {
    // If result arrived before this call, return it immediately
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
  },

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!app) throw new Error("Bridge not initialized");
    const result = await app.callServerTool({ name, arguments: args });
    return extractToolJson(result);
  },

  async sendMessage(text: string): Promise<void> {
    if (!app) throw new Error("Bridge not initialized");
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text }],
    });
  },
};
