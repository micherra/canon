/**
 * codebase-graph-filters.spec.ts
 *
 * Playwright BDD tests for the CodebaseGraph filter system.
 *
 * These tests serve the built dist/ui/codebase-graph.html and inject mock
 * graph data via page.addInitScript (before the Svelte app mounts).
 *
 * The bridge's callTool() is patched at the window level so the graph loads
 * without a live MCP server connection.
 *
 * Node display data is inspected via window.__SIGMA_GRAPH__ which is exposed
 * by buildSigmaGraph() for test purposes. This avoids WebGL pixel-reading.
 */

import { test, expect, type Page } from "@playwright/test";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";

// ── Mock script builder ──────────────────────────────────────────────────────

/**
 * Builds an inline script tag that provides two mocks:
 * 1. WebGL mock — Proxy-based stub that satisfies sigma's WebGL2 calls in
 *    headless Chromium (which has no GPU and returns null from getContext).
 *    Includes ANGLE_instanced_arrays extension and instanceof workaround.
 * 2. PostMessage bridge mock — simulates the MCP host that the ext-apps SDK
 *    communicates with; intercepts ui/initialize and tools/call requests.
 */
function buildMockScript(mockData: unknown): string {
  return `<script>
(function() {
  var _mock = ${JSON.stringify(mockData)};

  // ── WebGL mock ────────────────────────────────────────────────────────────
  var GL = { ZERO:0,ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,BLEND:3042,COLOR_BUFFER_BIT:16384,DEPTH_BUFFER_BIT:256,ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,DYNAMIC_DRAW:35048,FLOAT:5126,UNSIGNED_BYTE:5121,UNSIGNED_SHORT:5123,UNSIGNED_INT:5125,TRIANGLES:4,LINES:1,POINTS:0,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,LINK_STATUS:35714,COMPILE_STATUS:35713,TEXTURE_2D:3553,TEXTURE0:33984,RGBA:6408,RGB:6407,FRAMEBUFFER:36160,RENDERBUFFER:36161,COLOR_ATTACHMENT0:36064,DEPTH_ATTACHMENT:36096,FRAMEBUFFER_COMPLETE:36053,MAX_TEXTURE_SIZE:3379,MAX_VERTEX_ATTRIBS:34921,NO_ERROR:0,NEAREST:9728,LINEAR:9729,TEXTURE_MIN_FILTER:10241,TEXTURE_MAG_FILTER:10240,TEXTURE_WRAP_S:10242,TEXTURE_WRAP_T:10243,CLAMP_TO_EDGE:33071,REPEAT:10497,CULL_FACE:2884,DEPTH_TEST:2929 };
  var _oid = 1;
  function globj() { return { _id: _oid++ }; }
  var angleExt = { vertexAttribDivisorANGLE: function(){}, drawArraysInstancedANGLE: function(){}, drawElementsInstancedANGLE: function(){}, VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 35070 };
  var loseCtxExt = { loseContext: function(){}, restoreContext: function(){} };

  // Make mock satisfy instanceof WebGL2RenderingContext so sigma uses native
  // vertexAttribDivisor/drawArraysInstanced instead of ANGLE extension fallback.
  function FakeGL2() {}
  try { if (window.WebGL2RenderingContext) FakeGL2.prototype = Object.create(WebGL2RenderingContext.prototype); } catch(e) {}
  var mockGLBase = new FakeGL2();

  var mockGL = new Proxy(mockGLBase, {
    get: function(t, p) {
      if (p in GL) return GL[p];
      var ps = String(p);
      if (/^create/.test(ps)) return function() { return globj(); };
      if (ps === 'getExtension') return function(ext) {
        if (ext === 'ANGLE_instanced_arrays') return angleExt;
        if (ext === 'WEBGL_lose_context') return loseCtxExt;
        return {};
      };
      if (ps === 'getParameter') return function(v) { if(v===GL.MAX_TEXTURE_SIZE) return 4096; if(v===GL.MAX_VERTEX_ATTRIBS) return 16; return 0; };
      if (ps === 'getShaderParameter' || ps === 'getProgramParameter') return function() { return 1; };
      if (ps === 'getShaderInfoLog' || ps === 'getProgramInfoLog') return function() { return ''; };
      if (ps === 'checkFramebufferStatus') return function() { return GL.FRAMEBUFFER_COMPLETE; };
      if (ps === 'getError') return function() { return GL.NO_ERROR; };
      if (ps === 'getAttribLocation' || ps === 'getUniformLocation') return function() { return 0; };
      if (ps === 'canvas') return document.createElement('canvas');
      if (ps === 'drawingBufferWidth') return 1280;
      if (ps === 'drawingBufferHeight') return 900;
      if (ps === 'vertexAttribDivisor' || ps === 'drawArraysInstanced' || ps === 'drawElementsInstanced') return function(){};
      return function() {};
    }
  });

  var _origGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, opts) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return mockGL;
    return _origGC.call(this, type, opts);
  };

  // ── PostMessage bridge mock ───────────────────────────────────────────────
  try { Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true}); } catch(e) {}
  var _orig = window.postMessage.bind(window);
  window.postMessage = function(d,o,t) {
    if(d&&typeof d==='object'&&d.jsonrpc==='2.0'&&d.method){
      var id=d.id;
      function rep(r){if(id==null)return;window.dispatchEvent(new MessageEvent('message',{data:{jsonrpc:'2.0',id:id,result:r},source:window}));}
      if(d.method==='ui/initialize'){setTimeout(function(){rep({protocolVersion:'2025-03-26',hostCapabilities:{},hostInfo:{name:'TestHost',version:'1.0.0'},hostContext:{theme:'dark'}});},0);return;}
      if(d.method==='tools/call'||d.method==='tools/list'){setTimeout(function(){rep({content:[{type:'text',text:JSON.stringify(_mock)}]});},0);return;}
      if(id==null)return;
      setTimeout(function(){rep({});},0);
      return;
    }
    _orig(d,o||'*',t);
  };
  console.log('[test-mock] WebGL + bridge mocks installed');
})();
</script>`;
}

// ── Test data ───────────────────────────────────────────────────────────────

const MOCK_GRAPH_DATA = {
  nodes: [
    { id: "src/a.ts", layer: "handlers", changed: false, violation_count: 0, entity_count: 3 },
    { id: "src/b.ts", layer: "handlers", changed: false, violation_count: 2, entity_count: 2 },
    { id: "src/c.ts", layer: "services", changed: true, violation_count: 0, entity_count: 4 },
    { id: "src/d.ts", layer: "services", changed: true, violation_count: 1, entity_count: 1 },
    { id: "src/e.ts", layer: "utils", changed: false, violation_count: 0, entity_count: 5 },
    { id: "src/f.ts", layer: "utils", changed: false, violation_count: 0, entity_count: 2 },
    { id: "src/g.ts", layer: "utils", changed: false, violation_count: 0, entity_count: 1 },
    { id: "src/h.ts", layer: "models", changed: false, violation_count: 0, entity_count: 3 },
    { id: "src/i.ts", layer: "models", changed: false, violation_count: 0, entity_count: 2 },
    { id: "src/j.ts", layer: "models", changed: false, violation_count: 3, entity_count: 2 },
  ],
  edges: [
    { source: "src/a.ts", target: "src/c.ts", confidence: 1 },
    { source: "src/b.ts", target: "src/d.ts", confidence: 1 },
    { source: "src/c.ts", target: "src/e.ts", confidence: 0.9 },
    { source: "src/d.ts", target: "src/h.ts", confidence: 0.8 },
  ],
  layers: [
    { name: "handlers", color: "#6c8cff", file_count: 2 },
    { name: "services", color: "#22c55e", file_count: 2 },
    { name: "utils", color: "#f59e0b", file_count: 3 },
    { name: "models", color: "#a78bfa", file_count: 3 },
  ],
};

// Convenience sets derived from mock data
const VIOLATION_NODE_IDS = MOCK_GRAPH_DATA.nodes
  .filter((n) => (n.violation_count ?? 0) > 0)
  .map((n) => n.id);
// ["src/b.ts", "src/d.ts", "src/j.ts"]

const CHANGED_NODE_IDS = MOCK_GRAPH_DATA.nodes
  .filter((n) => n.changed)
  .map((n) => n.id);
// ["src/c.ts", "src/d.ts"]

const ALL_NODE_IDS = MOCK_GRAPH_DATA.nodes.map((n) => n.id);
const HANDLERS_NODE_IDS = MOCK_GRAPH_DATA.nodes.filter((n) => n.layer === "handlers").map((n) => n.id);
const SERVICES_NODE_IDS = MOCK_GRAPH_DATA.nodes.filter((n) => n.layer === "services").map((n) => n.id);
const UTILS_NODE_IDS = MOCK_GRAPH_DATA.nodes.filter((n) => n.layer === "utils").map((n) => n.id);
const MODELS_NODE_IDS = MOCK_GRAPH_DATA.nodes.filter((n) => n.layer === "models").map((n) => n.id);

// ── HTTP server for serving the built HTML ──────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = mcp-server/src/__tests__; dist is at mcp-server/dist/ui/
const distHtmlPath = join(__dirname, "../../dist/ui/codebase-graph.html");

let httpServer: Server;
let baseUrl: string;

test.beforeAll(async () => {
  const html = readFileSync(distHtmlPath, "utf-8");
  httpServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

// ── Helper: load the page with mock data injected ───────────────────────────

async function loadGraph(page: Page): Promise<void> {
  // The dist file is a self-contained HTML bundle using PostMessage to
  // communicate with the MCP host (parent window). In tests there is no
  // parent, so we inject a PostMessage interceptor that simulates the host.
  //
  // Strategy: Use page.route to intercept the HTML and inject a shim script
  // as the FIRST script that overrides window.postMessage before the bundle
  // runs. The shim intercepts json-rpc messages and sends synthetic responses.

  const mockScript = buildMockScript(MOCK_GRAPH_DATA);

  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("text/html")) {
      await route.fulfill({ response });
      return;
    }
    let body = await response.text();
    // Inject mock as the very first script element
    body = body.replace(/<\/head>/, `${mockScript}</head>`);
    await route.fulfill({
      response,
      body,
      contentType: "text/html; charset=utf-8",
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseUrl);

  // Wait for the graph data to load (stats bar shows node count)
  await page.waitForSelector(".stats-bar", { timeout: 15_000 });

  // Wait for __SIGMA_GRAPH__ to be available (set by buildSigmaGraph after sigma mounts)
  await page.waitForFunction(() => !!(window as any).__SIGMA_GRAPH__, { timeout: 20_000 });
}

// ── Helpers for inspecting sigma state ──────────────────────────────────────

/**
 * Get the display data for a node from sigma's internal state.
 * Returns { color, hidden, size, x, y } or null if not found.
 */
async function getNodeDisplayData(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const g = (window as any).__SIGMA_GRAPH__;
    if (!g?.sigma) return null;
    return g.sigma.getNodeDisplayData(id) ?? null;
  }, nodeId);
}

/**
 * Returns true if the node is visible (not hidden) in sigma.
 */
async function isNodeVisible(page: Page, nodeId: string): Promise<boolean> {
  const data = await getNodeDisplayData(page, nodeId);
  if (!data) return false;
  return data.hidden !== true;
}

/**
 * Returns true if the node is hidden in sigma.
 */
async function isNodeHidden(page: Page, nodeId: string): Promise<boolean> {
  const data = await getNodeDisplayData(page, nodeId);
  if (!data) return true; // missing = not rendered = hidden
  return data.hidden === true;
}

/**
 * Returns the color of the node from sigma display data.
 */
async function getNodeColor(page: Page, nodeId: string): Promise<string | null> {
  const data = await getNodeDisplayData(page, nodeId);
  return data?.color ?? null;
}

/**
 * Count visible nodes from a list.
 */
async function countVisible(page: Page, nodeIds: string[]): Promise<number> {
  let count = 0;
  for (const id of nodeIds) {
    if (await isNodeVisible(page, id)) count++;
  }
  return count;
}

// ── Helpers for interacting with the filter bar ──────────────────────────────

async function clickViolationsFilter(page: Page): Promise<void> {
  await page.click("button.filter-btn.violations");
}

async function clickChangedFilter(page: Page): Promise<void> {
  await page.click("button.filter-btn.changed");
}

async function expandLayers(page: Page): Promise<void> {
  // The layers button is the filter-btn that shows "{n} layers"
  const layersBtn = page.locator("button.filter-btn").filter({ hasText: /layers/i });
  await layersBtn.first().click();
}

async function clickLayerChip(page: Page, layerName: string): Promise<void> {
  await page.click(`.layer-chip:has-text("${layerName}")`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("CodebaseGraph filter bar", () => {
  test.describe("Default view", () => {
    test("all nodes should be visible after graph loads", async ({ page }) => {
      await loadGraph(page);
      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(ALL_NODE_IDS.length);
    });

    test("violation nodes should have red color (#ff6b6b)", async ({ page }) => {
      await loadGraph(page);
      for (const id of VIOLATION_NODE_IDS) {
        const color = await getNodeColor(page, id);
        expect(color, `Expected ${id} to be red`).toBe("#ff6b6b");
      }
    });

    test("changed nodes should have blue color (#6c8cff)", async ({ page }) => {
      await loadGraph(page);
      // src/c.ts is changed but has no violations — should be blue
      const color = await getNodeColor(page, "src/c.ts");
      expect(color).toBe("#6c8cff");
    });

    test("violation color wins over changed color when node has both", async ({ page }) => {
      await loadGraph(page);
      // src/d.ts is changed AND has violations — violation (red) should win
      const color = await getNodeColor(page, "src/d.ts");
      expect(color).toBe("#ff6b6b");
    });

    test("no node should have black color (no black nodes bug)", async ({ page }) => {
      await loadGraph(page);
      const BLACK_THRESHOLD = 30; // RGB components below this are "black-ish"

      for (const id of ALL_NODE_IDS) {
        const color = await getNodeColor(page, id);
        if (!color) continue;
        // Parse hex color #rrggbb
        if (color.startsWith("#") && color.length === 7) {
          const r = parseInt(color.slice(1, 3), 16);
          const g = parseInt(color.slice(3, 5), 16);
          const b = parseInt(color.slice(5, 7), 16);
          const isBlack = r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD;
          expect(isBlack, `Node ${id} has near-black color ${color}`).toBe(false);
        }
        // Reject NODE_UNFOCUSED (rgba near-invisible) as default color
        if (color.includes("rgba")) {
          // Extract alpha — near-invisible nodes (alpha < 0.15) are effectively black
          const alphaMatch = color.match(/rgba\([^)]+,\s*([\d.]+)\)/);
          if (alphaMatch) {
            const alpha = parseFloat(alphaMatch[1]);
            expect(alpha, `Node ${id} has near-invisible color ${color}`).toBeGreaterThan(0.15);
          }
        }
      }
    });
  });

  test.describe("Violations filter", () => {
    test("clicking violations filter hides non-violation nodes", async ({ page }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);

      // Wait for sigma to re-render
      await page.waitForTimeout(100);

      for (const id of ALL_NODE_IDS) {
        const shouldBeVisible = VIOLATION_NODE_IDS.includes(id);
        if (shouldBeVisible) {
          expect(await isNodeVisible(page, id), `${id} should be visible`).toBe(true);
        } else {
          expect(await isNodeHidden(page, id), `${id} should be hidden`).toBe(true);
        }
      }
    });

    test("only violation nodes are visible when violations filter is active", async ({ page }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(VIOLATION_NODE_IDS.length);
    });

    test("toggling violations filter off restores all nodes", async ({ page }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      // Toggle off
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(ALL_NODE_IDS.length);
    });

    test("violation nodes get red color when violations filter is active", async ({ page }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      for (const id of VIOLATION_NODE_IDS) {
        const color = await getNodeColor(page, id);
        expect(color, `Expected ${id} to be red under violations filter`).toBe("#ff6b6b");
      }
    });
  });

  test.describe("Changed filter", () => {
    test("clicking changed filter hides non-changed nodes", async ({ page }) => {
      await loadGraph(page);
      await clickChangedFilter(page);
      await page.waitForTimeout(100);

      for (const id of ALL_NODE_IDS) {
        const shouldBeVisible = CHANGED_NODE_IDS.includes(id);
        if (shouldBeVisible) {
          expect(await isNodeVisible(page, id), `${id} should be visible`).toBe(true);
        } else {
          expect(await isNodeHidden(page, id), `${id} should be hidden`).toBe(true);
        }
      }
    });

    test("only changed nodes are visible when changed filter is active", async ({ page }) => {
      await loadGraph(page);
      await clickChangedFilter(page);
      await page.waitForTimeout(100);

      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(CHANGED_NODE_IDS.length);
    });

    test("toggling changed filter off restores all nodes", async ({ page }) => {
      await loadGraph(page);
      await clickChangedFilter(page);
      await page.waitForTimeout(100);

      // Toggle off
      await clickChangedFilter(page);
      await page.waitForTimeout(100);

      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(ALL_NODE_IDS.length);
    });
  });

  test.describe("Layer chip filter", () => {
    test("toggling off a layer chip hides that layer's nodes", async ({ page }) => {
      await loadGraph(page);
      await expandLayers(page);
      await page.waitForTimeout(50);

      await clickLayerChip(page, "handlers");
      await page.waitForTimeout(100);

      for (const id of HANDLERS_NODE_IDS) {
        expect(await isNodeHidden(page, id), `${id} should be hidden`).toBe(true);
      }
    });

    test("non-toggled layers remain visible when one layer is hidden", async ({ page }) => {
      await loadGraph(page);
      await expandLayers(page);
      await page.waitForTimeout(50);

      await clickLayerChip(page, "handlers");
      await page.waitForTimeout(100);

      // Services, utils, models nodes should still be visible
      const otherNodes = [...SERVICES_NODE_IDS, ...UTILS_NODE_IDS, ...MODELS_NODE_IDS];
      const visibleCount = await countVisible(page, otherNodes);
      expect(visibleCount).toBe(otherNodes.length);
    });

    test("re-toggling a layer chip restores those nodes", async ({ page }) => {
      await loadGraph(page);
      await expandLayers(page);
      await page.waitForTimeout(50);

      await clickLayerChip(page, "handlers");
      await page.waitForTimeout(100);
      await clickLayerChip(page, "handlers");
      await page.waitForTimeout(100);

      const visibleCount = await countVisible(page, ALL_NODE_IDS);
      expect(visibleCount).toBe(ALL_NODE_IDS.length);
    });
  });

  test.describe("Combined filters", () => {
    test("violations filter + layer filter: only violation nodes in active layers are visible", async ({
      page,
    }) => {
      await loadGraph(page);
      await expandLayers(page);
      await page.waitForTimeout(50);

      // Disable the handlers layer
      await clickLayerChip(page, "handlers");
      await page.waitForTimeout(50);
      // Enable violations filter
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      // Handlers violation node (src/b.ts) should be hidden (layer off)
      expect(await isNodeHidden(page, "src/b.ts")).toBe(true);

      // Services violation node with violations (src/d.ts) should be visible
      expect(await isNodeVisible(page, "src/d.ts")).toBe(true);

      // Models violation node (src/j.ts) should be visible
      expect(await isNodeVisible(page, "src/j.ts")).toBe(true);

      // Non-violation nodes should be hidden
      expect(await isNodeHidden(page, "src/a.ts")).toBe(true);
      expect(await isNodeHidden(page, "src/c.ts")).toBe(true);
    });

    test("changed + violations filters: shows nodes that are changed OR have violations", async ({
      page,
    }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);
      await page.waitForTimeout(50);
      await clickChangedFilter(page);
      await page.waitForTimeout(100);

      // Expected visible: union of violation nodes and changed nodes
      const expectedVisible = new Set([...VIOLATION_NODE_IDS, ...CHANGED_NODE_IDS]);

      for (const id of ALL_NODE_IDS) {
        if (expectedVisible.has(id)) {
          expect(await isNodeVisible(page, id), `${id} should be visible`).toBe(true);
        } else {
          expect(await isNodeHidden(page, id), `${id} should be hidden`).toBe(true);
        }
      }
    });
  });

  test.describe("No black nodes invariant", () => {
    test("no node should render with near-invisible color in default view", async ({ page }) => {
      await loadGraph(page);

      for (const id of ALL_NODE_IDS) {
        const data = await getNodeDisplayData(page, id);
        expect(data, `${id} should have display data`).toBeTruthy();
        expect(data!.hidden, `${id} should not be hidden`).not.toBe(true);

        // NODE_UNFOCUSED = "rgba(107, 115, 148, 0.07)" — reject this as a default color
        const color: string = data!.color ?? "";
        expect(
          color,
          `${id} should not have near-invisible NODE_UNFOCUSED color`,
        ).not.toContain("0.07");
      }
    });

    test("no node has NODE_UNFOCUSED color when violations filter is active", async ({ page }) => {
      await loadGraph(page);
      await clickViolationsFilter(page);
      await page.waitForTimeout(100);

      // Visible nodes (violations) should have real colors, not dimmed ones
      for (const id of VIOLATION_NODE_IDS) {
        const color = await getNodeColor(page, id);
        expect(color, `${id} should not be unfocused color`).not.toContain("0.07");
        expect(color, `${id} should not be dim color`).not.toContain("0.2)");
      }
    });
  });
});
