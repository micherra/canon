import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

let app: App | null = null;

function extractToolText(result: CallToolResult): string {
  const c = result.content?.find((c) => c.type === "text");
  return c ? (c as { type: "text"; text: string }).text : "";
}

function extractToolJson(result: CallToolResult): any {
  const text = extractToolText(result);
  return text ? JSON.parse(text) : null;
}

export const bridge = {
  async init() {
    const instance = new App(
      { name: "Canon Dashboard", version: "0.1.0" },
      {},
      { autoResize: true },
    );

    instance.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };

    instance.onerror = console.error;

    await instance.connect();
    app = instance;

    // Apply initial host context
    const ctx = instance.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  },

  async request(type: string, payload?: Record<string, unknown>): Promise<any> {
    if (!app) throw new Error("Bridge not initialized");
    // Map message types to tool calls
    switch (type) {
      case "webviewReady":
        return {}; // No-op in MCP App context
      case "getBranch": {
        const result = await app.callServerTool({ name: "get_branch", arguments: {} });
        return extractToolJson(result);
      }
      case "getFile": {
        const result = await app.callServerTool({
          name: "get_file_content",
          arguments: { file_path: payload?.path as string },
        });
        return extractToolJson(result);
      }
      case "getSummary": {
        const result = await app.callServerTool({
          name: "get_summary",
          arguments: { file_id: payload?.fileId as string },
        });
        return extractToolJson(result);
      }
      case "getComplianceTrend": {
        const result = await app.callServerTool({
          name: "get_compliance_trend",
          arguments: { principle_id: payload?.principleId as string },
        });
        return extractToolJson(result);
      }
      case "getPrReviews": {
        const result = await app.callServerTool({ name: "get_pr_reviews", arguments: {} });
        return extractToolJson(result);
      }
      case "refreshGraph": {
        const result = await app.callServerTool({ name: "codebase_graph", arguments: {} });
        return extractToolJson(result);
      }
      default:
        console.warn(`[Canon] Unknown bridge request type: ${type}`);
        return {};
    }
  },

  async notifyNodeSelected(
    node: { id: string; layer: string; summary: string; violation_count: number } | null,
  ) {
    if (!app) return;
    try {
      await app.callServerTool({
        name: "update_dashboard_state",
        arguments: { selectedNode: node },
      });
    } catch (e) {
      console.error("[Canon] Failed to update dashboard state:", e);
    }
  },

  openFile(_filePath: string) {
    // No-op: MCP Apps cannot open files in the host editor
    // This is an accepted regression (DEC-03)
  },
};
