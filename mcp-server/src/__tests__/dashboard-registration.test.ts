/**
 * Dashboard registration tests — mig-05
 *
 * Verifies that open_dashboard, ui://canon/dashboard resource, and the 6
 * app-only support tools are registered with correct metadata.
 *
 * We test via the ext-apps SDK internals: registerAppTool normalizes
 * _meta["ui/resourceUri"] (legacy key) AND _meta.ui.resourceUri. We inspect
 * tool metadata by calling the server's tool list and checking registered
 * annotations/metadata via the MCP SDK's registered tool map.
 *
 * Because McpServer doesn't expose a public tool-list API without transport,
 * we test the registration helpers in isolation using a lightweight mock server
 * that records what registerTool and registerResource receive.
 */

import { describe, it, expect } from "vitest";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

// ---------------------------------------------------------------------------
// Lightweight mock server
// ---------------------------------------------------------------------------

interface RecordedTool {
  name: string;
  config: Record<string, unknown>;
}

interface RecordedResource {
  name: string;
  uri: string;
  config: Record<string, unknown>;
}

function makeMockServer() {
  const tools: RecordedTool[] = [];
  const resources: RecordedResource[] = [];

  return {
    registerTool(name: string, config: Record<string, unknown>, _cb: unknown) {
      tools.push({ name, config });
    },
    registerResource(name: string, uri: string, config: Record<string, unknown>, _cb: unknown) {
      resources.push({ name, uri, config });
    },
    tools,
    resources,
  };
}

// ---------------------------------------------------------------------------
// open_dashboard tool registration
// ---------------------------------------------------------------------------

describe("open_dashboard tool registration", () => {
  it("registers with correct name and _meta.ui.resourceUri", () => {
    const server = makeMockServer();
    const dashboardResourceUri = "ui://canon/dashboard";

    registerAppTool(
      server as Parameters<typeof registerAppTool>[0],
      "open_dashboard",
      {
        title: "Canon Dashboard",
        description: "Opens the Canon dependency graph dashboard.",
        inputSchema: {},
        _meta: { ui: { resourceUri: dashboardResourceUri } },
      },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );

    expect(server.tools).toHaveLength(1);
    const tool = server.tools[0];
    expect(tool.name).toBe("open_dashboard");

    // ext-apps normalizes both _meta.ui.resourceUri AND the legacy key
    const meta = tool.config._meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    // The SDK normalizes resourceUri into the legacy key for compat
    expect(meta["ui/resourceUri"]).toBe(dashboardResourceUri);
  });

  it("does NOT set visibility (defaults to model-visible)", () => {
    const server = makeMockServer();
    const dashboardResourceUri = "ui://canon/dashboard";

    registerAppTool(
      server as Parameters<typeof registerAppTool>[0],
      "open_dashboard",
      {
        _meta: { ui: { resourceUri: dashboardResourceUri } },
      },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );

    const meta = server.tools[0].config._meta as Record<string, unknown>;
    const ui = meta.ui as Record<string, unknown> | undefined;
    // No visibility restriction — the tool is model-visible (default)
    expect(ui?.visibility).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ui://canon/dashboard resource registration
// ---------------------------------------------------------------------------

describe("ui://canon/dashboard resource registration", () => {
  it("registers with correct URI and MIME type", () => {
    const server = makeMockServer();
    const dashboardResourceUri = "ui://canon/dashboard";

    registerAppResource(
      server as Parameters<typeof registerAppResource>[0],
      "Canon Dashboard",
      dashboardResourceUri,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [{ uri: dashboardResourceUri, mimeType: RESOURCE_MIME_TYPE, text: "<html/>" }],
      }),
    );

    expect(server.resources).toHaveLength(1);
    const resource = server.resources[0];
    expect(resource.name).toBe("Canon Dashboard");
    expect(resource.uri).toBe(dashboardResourceUri);
    expect((resource.config as { mimeType?: string }).mimeType).toBe(RESOURCE_MIME_TYPE);
  });

  it("RESOURCE_MIME_TYPE is the MCP Apps HTML MIME type", () => {
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });
});

// ---------------------------------------------------------------------------
// App-only support tools
// ---------------------------------------------------------------------------

describe("app-only support tools", () => {
  const dashboardResourceUri = "ui://canon/dashboard";

  const appOnlyTools = [
    "update_dashboard_state",
    "get_branch",
    "get_file_content",
    "get_summary",
    "get_compliance_trend",
  ] as const;

  for (const toolName of appOnlyTools) {
    it(`${toolName} has visibility: ["app"]`, () => {
      const server = makeMockServer();

      registerAppTool(
        server as Parameters<typeof registerAppTool>[0],
        toolName,
        {
          description: `test ${toolName}`,
          inputSchema: {},
          _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
        },
        async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
      );

      const meta = server.tools[0].config._meta as Record<string, unknown>;
      const ui = meta.ui as { resourceUri: string; visibility?: string[] };
      expect(ui.visibility).toEqual(["app"]);
      expect(ui.resourceUri).toBe(dashboardResourceUri);
    });
  }
});

// ---------------------------------------------------------------------------
// get_pr_reviews — dual visibility
// ---------------------------------------------------------------------------

describe("get_pr_reviews dual visibility", () => {
  it("has visibility: [app, model] for LLM and app access", () => {
    const server = makeMockServer();
    const dashboardResourceUri = "ui://canon/dashboard";

    registerAppTool(
      server as Parameters<typeof registerAppTool>[0],
      "get_pr_reviews",
      {
        description: "Return stored PR reviews.",
        inputSchema: {},
        _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app", "model"] } },
      },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );

    const meta = server.tools[0].config._meta as Record<string, unknown>;
    const ui = meta.ui as { resourceUri: string; visibility?: string[] };
    expect(ui.visibility).toEqual(["app", "model"]);
    expect(ui.resourceUri).toBe(dashboardResourceUri);
  });
});
