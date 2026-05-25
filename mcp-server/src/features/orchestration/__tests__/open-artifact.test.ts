/**
 * Tests for open-artifact.ts
 *
 * open_artifact reads an HTML file from the workspace artifacts directory
 * and opens it in the browser via the Canon HTTP server.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@app/http-server.ts", () => ({
  getHttpPort: vi.fn(() => 3457),
  isHttpServerRunning: vi.fn(() => true),
  registerArtifact: vi.fn(),
}));

vi.mock("@platform/adapters/process-adapter.ts", () => ({
  openBrowser: vi.fn(),
}));

import { isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import { openArtifact } from "../tools/open-artifact.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspaceDir: string;
let artifactsDir: string;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(isHttpServerRunning).mockReturnValue(true);

  // Create a fresh temp workspace with an artifacts subdirectory
  workspaceDir = await mkdtemp(join(tmpdir(), "open-artifact-test-"));
  const { mkdir } = await import("node:fs/promises");
  artifactsDir = join(workspaceDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openArtifact", () => {
  describe("happy path", () => {
    it("opens an existing HTML file and returns url", async () => {
      const html = "<html><body>review</body></html>";
      await writeFile(join(artifactsDir, "review.html"), html, "utf8");

      const result = await openArtifact({
        artifact_name: "review.html",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toContain("artifact/");
      }
    });

    it("appends .html extension when not present", async () => {
      const html = "<html><body>design</body></html>";
      await writeFile(join(artifactsDir, "design.html"), html, "utf8");

      const result = await openArtifact({
        artifact_name: "design",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(true);
    });

    it("registers artifact with the http server", async () => {
      const html = "<html>content</html>";
      await writeFile(join(artifactsDir, "review.html"), html, "utf8");

      await openArtifact({
        artifact_name: "review.html",
        workspace: workspaceDir,
      });

      expect(registerArtifact).toHaveBeenCalledOnce();
      const [, registeredHtml] = vi.mocked(registerArtifact).mock.calls[0];
      expect(registeredHtml).toBe(html);
    });

    it("opens browser at artifact URL", async () => {
      await writeFile(join(artifactsDir, "review.html"), "<html/>", "utf8");

      await openArtifact({
        artifact_name: "review.html",
        workspace: workspaceDir,
      });

      expect(openBrowser).toHaveBeenCalledOnce();
    });
  });

  describe("file not found", () => {
    it("returns INVALID_INPUT when file does not exist", async () => {
      const result = await openArtifact({
        artifact_name: "nonexistent.html",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toContain("nonexistent.html");
      }
    });

    it("does not open browser when file not found", async () => {
      await openArtifact({
        artifact_name: "missing.html",
        workspace: workspaceDir,
      });

      expect(openBrowser).not.toHaveBeenCalled();
    });
  });

  describe("path traversal prevention", () => {
    it("blocks path traversal via ..", async () => {
      const result = await openArtifact({
        artifact_name: "../../../etc/passwd",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toContain("outside");
      }
    });

    it("blocks absolute path in artifact_name", async () => {
      const result = await openArtifact({
        artifact_name: "/etc/passwd",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
      }
    });

    it("allows simple names within artifacts dir", async () => {
      await writeFile(join(artifactsDir, "safe.html"), "<html/>", "utf8");

      const result = await openArtifact({
        artifact_name: "safe.html",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("HTTP server not running", () => {
    it("returns UNEXPECTED when HTTP server is not running", async () => {
      vi.mocked(isHttpServerRunning).mockReturnValue(false);
      await writeFile(join(artifactsDir, "review.html"), "<html/>", "utf8");

      const result = await openArtifact({
        artifact_name: "review.html",
        workspace: workspaceDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("UNEXPECTED");
        expect(result.recoverable).toBe(true);
      }
    });
  });
});
