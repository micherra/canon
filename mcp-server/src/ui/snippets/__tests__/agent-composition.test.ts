/**
 * Integration test: agent composition demo for the snippet library.
 *
 * Demonstrates the agent composition workflow:
 * 1. Discover snippets via readdirSync
 * 2. Verify every snippet has a structured docblock
 * 3. Compose a custom HTML page from verdict-banner + stats-card snippets
 * 4. Serve via registerArtifact from the HTTP server
 * 5. Verify HTTP 200 response with expected content
 * 6. Clean up via removeArtifact
 *
 * Canon principles:
 *   - compose-from-small-to-large: proven by step 3 — small snippets compose into a full artifact
 *   - functions-do-one-thing: each helper (substituteSnippet, extractSnippetHtml, extractSnippetStyles) does one thing
 */

import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getHttpPort,
  registerArtifact,
  removeArtifact,
  resetStateForTesting,
  startHttpServer,
  stopHttpServer,
} from "@app/http-server.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── Path resolution ──────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SNIPPETS_DIR = join(__dirname, "..");

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function httpGet(path: string): Promise<{ status: number; body: string }> {
  const port = getHttpPort();
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", method: "GET", path, port }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({ body, status: res.statusCode ?? 0 });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Snippet composition helpers ──────────────────────────────────────────────

/** Replace all {{PLACEHOLDER}} occurrences in a snippet string. */
function substituteSnippet(snippet: string, replacements: Record<string, string>): string {
  let result = snippet;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Extract the HTML markup from a snippet file (everything outside <style> tags).
 * Strips the leading docblock comment and <style> blocks; returns the markup only.
 */
function extractSnippetHtml(snippetContent: string): string {
  // Remove the leading docblock (<!-- ... -->)
  const withoutDocblock = snippetContent.replace(/^<!--[\s\S]*?-->\s*/m, "");
  // Remove <style>...</style> blocks
  return withoutDocblock.replace(/<style>[\s\S]*?<\/style>/g, "").trim();
}

/**
 * Extract all <style>...</style> blocks from a snippet file as a single joined string.
 */
function extractSnippetStyles(snippetContent: string): string {
  const styleMatches = snippetContent.match(/<style>([\s\S]*?)<\/style>/g) ?? [];
  return styleMatches.map((block) => block.replace(/<\/?style>/g, "").trim()).join("\n");
}

// ── Test port (avoids conflict with other test files) ────────────────────────

const TEST_PORT = 23141;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("snippet library — agent composition demo", () => {
  beforeAll(async () => {
    await startHttpServer(TEST_PORT);
  });

  afterAll(async () => {
    resetStateForTesting();
    await stopHttpServer();
  });

  // ── 1. Snippet discovery ─────────────────────────────────────────────────

  describe("snippet discovery", () => {
    it("finds at least 8 HTML snippet files in the snippets directory", () => {
      const entries = readdirSync(SNIPPETS_DIR, { withFileTypes: true });
      const htmlFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".html"));
      expect(htmlFiles.length).toBeGreaterThanOrEqual(8);
    });
  });

  // ── 2. Docblock verification ──────────────────────────────────────────────

  describe("structured docblocks", () => {
    it("every snippet file has all 5 required docblock tags", () => {
      const entries = readdirSync(SNIPPETS_DIR, { withFileTypes: true });
      const htmlFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".html"))
        .map((e) => e.name);

      expect(htmlFiles.length).toBeGreaterThanOrEqual(8);

      for (const filename of htmlFiles) {
        const content = readFileSync(join(SNIPPETS_DIR, filename), "utf8");

        // Must start with a docblock comment
        expect(content.trimStart().startsWith("<!--"), `${filename}: must start with <!--`).toBe(
          true,
        );

        // Must contain all 5 structured tags
        for (const tag of ["@snippet", "@description", "@data", "@tokens", "@usage"]) {
          expect(content, `${filename}: missing ${tag}`).toContain(tag);
        }
      }
    });
  });

  // ── 3–6. Composition → serve → verify → cleanup ──────────────────────────

  describe("agent composition workflow", () => {
    it("composes verdict-banner + two stats-cards into a served HTML artifact (HTTP 200)", async () => {
      // Step 3a: Read source snippets
      const bannerContent = readFileSync(join(SNIPPETS_DIR, "verdict-banner.html"), "utf8");
      const statsContent = readFileSync(join(SNIPPETS_DIR, "stats-card.html"), "utf8");

      // Step 3b: Substitute placeholders in the verdict-banner
      const substitutedBanner = substituteSnippet(bannerContent, {
        ACCENT_COLOR: "#27ae60",
        HEADLINE: "All checks passing — no violations found",
        VERDICT: "CLEAN",
      });

      // Step 3c: Substitute placeholders in two stats-card instances
      const statsCard1 = substituteSnippet(statsContent, {
        LABEL: "Files reviewed",
        VALUE: "42",
      });
      const statsCard2 = substituteSnippet(statsContent, {
        LABEL: "Violations",
        VALUE: "0",
      });

      // Step 3d: Extract markup and styles
      const bannerHtml = extractSnippetHtml(substitutedBanner);
      const bannerStyles = extractSnippetStyles(substitutedBanner);

      const statsHtml1 = extractSnippetHtml(statsCard1);
      const statsHtml2 = extractSnippetHtml(statsCard2);
      const statsStyles = extractSnippetStyles(statsCard1); // styles are identical for both instances

      // Step 3e: Build base CSS tokens (mirroring base.css design tokens)
      const baseCssTokens = `
        :root {
          --bg: #0c0f1a;
          --bg-card: rgba(255, 255, 255, 0.06);
          --text: #b4b8c8;
          --text-muted: #636a80;
          --border: rgba(255, 255, 255, 0.06);
          --danger: #ff6b6b;
          --success: #34d399;
        }
        body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; }
        .stats-row { display: flex; gap: 12px; padding: 16px; }
      `;

      // Step 3f: Assemble the composed HTML page
      const composedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Canon Agent Composition Demo</title>
  <style>
    ${baseCssTokens}
    ${bannerStyles}
    ${statsStyles}
  </style>
</head>
<body>
  <div id="app">
    ${bannerHtml}
    <div class="stats-row">
      ${statsHtml1}
      ${statsHtml2}
    </div>
  </div>
</body>
</html>`;

      // Step 4: Serve via registerArtifact
      const artifactKey = "custom/agent-test";
      registerArtifact(artifactKey, composedHtml, {});

      // Step 5: Verify HTTP 200 response
      const res = await httpGet("/artifact/custom/agent-test");
      expect(res.status).toBe(200);

      // Verify the composed content is present
      expect(res.body).toContain("CLEAN");
      expect(res.body).toContain("All checks passing");
      expect(res.body).toContain("#27ae60");
      expect(res.body).toContain("42");
      expect(res.body).toContain("Files reviewed");
      expect(res.body).toContain("Violations");

      // Verify structural elements
      expect(res.body).toContain("verdict-banner");
      expect(res.body).toContain("verdict-badge");
      expect(res.body).toContain("stat-card");
      expect(res.body).toContain("stat-value");

      // Step 6: Cleanup
      removeArtifact(artifactKey);

      // Verify cleanup: artifact should now return 404
      const afterCleanup = await httpGet("/artifact/custom/agent-test");
      expect(afterCleanup.status).toBe(404);
    });

    it("composed HTML contains expected visual elements from both snippets", async () => {
      const bannerContent = readFileSync(join(SNIPPETS_DIR, "verdict-banner.html"), "utf8");
      const statsContent = readFileSync(join(SNIPPETS_DIR, "stats-card.html"), "utf8");

      const substitutedBanner = substituteSnippet(bannerContent, {
        ACCENT_COLOR: "#e74c3c",
        HEADLINE: "1 blocking violation found",
        VERDICT: "BLOCKING",
      });
      const substitutedStats = substituteSnippet(statsContent, {
        LABEL: "Blocking issues",
        VALUE: "1",
      });

      const composedHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Test</title>
<style>:root { --text: #e0e0e0; --bg: #0c0f1a; --bg-card: rgba(255,255,255,0.04); --border: rgba(255,255,255,0.07); }</style>
</head>
<body>
${extractSnippetHtml(substitutedBanner)}
<div class="stats-row" style="display:flex;gap:12px;padding:16px;">
${extractSnippetHtml(substitutedStats)}
</div>
</body>
</html>`;

      registerArtifact("custom/agent-test-2", composedHtml, {});

      const res = await httpGet("/artifact/custom/agent-test-2");
      expect(res.status).toBe(200);

      // Verify verdict badge text
      expect(res.body).toContain("BLOCKING");
      // Verify stat value
      expect(res.body).toContain(">1<");
      // Verify stat label
      expect(res.body).toContain("Blocking issues");
      // Verify accent color
      expect(res.body).toContain("#e74c3c");

      removeArtifact("custom/agent-test-2");
    });

    it("composes collapsible-section snippet into a served HTML artifact (HTTP 200)", async () => {
      const snippetContent = readFileSync(join(SNIPPETS_DIR, "collapsible-section.html"), "utf8");

      // Substitute placeholders
      const substituted = substituteSnippet(snippetContent, {
        TITLE: "Implementation Notes",
        CONTENT: "<p>Details about the implementation approach.</p>",
      });

      const styles = extractSnippetStyles(substituted);
      const markup = extractSnippetHtml(substituted);

      const composedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Collapsible Section Test</title>
  <style>
    :root { --bg: #0c0f1a; --bg-card: rgba(255,255,255,0.06); --border: rgba(255,255,255,0.06); --text: #b4b8c8; --text-bright: #e8eaf0; --text-muted: #636a80; }
    body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; }
    ${styles}
  </style>
</head>
<body>
  ${markup}
</body>
</html>`;

      const artifactKey = "custom/collapsible-test";
      registerArtifact(artifactKey, composedHtml, {});

      const res = await httpGet("/artifact/custom/collapsible-test");
      expect(res.status).toBe(200);

      // Verify collapsible-specific structure
      expect(res.body).toContain("<details");
      expect(res.body).toContain("<summary");
      expect(res.body).toContain("Implementation Notes");
      expect(res.body).toContain("Details about the implementation approach.");

      removeArtifact(artifactKey);
    });

    it("composes requirement-table snippet with color-coded dispositions (HTTP 200)", async () => {
      const snippetContent = readFileSync(join(SNIPPETS_DIR, "requirement-table.html"), "utf8");

      const sampleRows = `
        <tr>
          <td>1</td>
          <td>Design system tokens extracted</td>
          <td><span class="disposition disposition--covered">covered</span></td>
          <td>DESIGN-SYSTEM.md Section A</td>
        </tr>
        <tr>
          <td>2</td>
          <td>Agent composition tests pass</td>
          <td><span class="disposition disposition--partial">partial</span></td>
          <td>Missing edge cases</td>
        </tr>
        <tr>
          <td>3</td>
          <td>Dark mode support</td>
          <td><span class="disposition disposition--descoped">descoped</span></td>
          <td>Out of scope for this task</td>
        </tr>
      `;

      const substituted = substituteSnippet(snippetContent, {
        TABLE_ROWS: sampleRows,
      });

      const styles = extractSnippetStyles(substituted);
      const markup = extractSnippetHtml(substituted);

      const composedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Requirement Table Test</title>
  <style>
    :root {
      --bg: #0c0f1a; --bg-card: rgba(255,255,255,0.06); --bg-surface: rgba(255,255,255,0.03);
      --border: rgba(255,255,255,0.06); --text: #b4b8c8; --text-bright: #e8eaf0;
      --success: #34d399; --warning: #fbbf24; --info: #60a5fa;
    }
    body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; }
    ${styles}
  </style>
</head>
<body>
  ${markup}
</body>
</html>`;

      const artifactKey = "custom/requirement-table-test";
      registerArtifact(artifactKey, composedHtml, {});

      const res = await httpGet("/artifact/custom/requirement-table-test");
      expect(res.status).toBe(200);

      // Verify table structure
      expect(res.body).toContain("<table");
      expect(res.body).toContain("<th");
      expect(res.body).toContain("Requirement");
      expect(res.body).toContain("Disposition");

      // Verify all three disposition classes are represented
      expect(res.body).toContain("disposition--covered");
      expect(res.body).toContain("disposition--partial");
      expect(res.body).toContain("disposition--descoped");

      // Verify row content
      expect(res.body).toContain("Design system tokens extracted");
      expect(res.body).toContain("Dark mode support");

      removeArtifact(artifactKey);
    });
  });
});
