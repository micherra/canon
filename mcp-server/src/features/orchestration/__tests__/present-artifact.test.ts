/**
 * Tests for present-artifact.ts
 *
 * The only supported path is the html parameter path — callers must pass
 * HTML content directly. No compiled-view fallback exists.
 *
 * Also covers DEC-05: daemon-active state seeded via mock — present_artifact
 * resolves URLs to the daemon port when isHttpServerRunning() is true and
 * getHttpPort() returns the daemon port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@app/http-server.ts", () => ({
  getHttpPort: vi.fn(() => 3457),
  isHttpServerRunning: vi.fn(() => true),
  markDaemonArtifactActive: vi.fn(),
  registerArtifact: vi.fn(),
  setHttpPort: vi.fn(),
}));

vi.mock("@platform/adapters/process-adapter.ts", () => ({
  openBrowser: vi.fn(),
}));

import { getHttpPort, isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import { presentArtifact } from "../tools/present-artifact.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("presentArtifact", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isHttpServerRunning).mockReturnValue(true);
  });

  describe("html path", () => {
    it("serves inline html and registers artifact", async () => {
      const html = "<html><body>Design</body></html>";

      const result = await presentArtifact({
        data: {},
        html,
        slug: "my-build",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toContain("design/my-build");
      }
    });

    it("registers the artifact with the provided html", async () => {
      const html = "<html>Review</html>";

      await presentArtifact({
        data: { has_review: true },
        html,
        slug: "slug",
        type: "review",
        workspace: "/ws",
      });

      expect(registerArtifact).toHaveBeenCalledWith("review/slug", html, { has_review: true });
    });

    it("opens browser at the artifact URL", async () => {
      await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "test",
        type: "design",
        workspace: "/ws",
      });

      expect(openBrowser).toHaveBeenCalledOnce();
      expect(vi.mocked(openBrowser).mock.calls[0][0]).toContain("design/test");
    });
  });

  describe("html parameter is required", () => {
    it("returns INVALID_INPUT when html is not provided", async () => {
      const result = await presentArtifact({
        data: {},
        slug: "my-slug",
        type: "planning-brief",
        workspace: "/ws",
        // no html
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toContain("No html content provided");
      }
    });

    it("error message mentions the artifact type and instructs to pass html parameter", async () => {
      const result = await presentArtifact({
        data: {},
        slug: "s",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("design");
        expect(result.message).toContain("html parameter");
      }
    });

    it("returns INVALID_INPUT for any type when no html provided", async () => {
      const result = await presentArtifact({
        data: {},
        slug: "slug",
        type: "unknown-type",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
      }
    });
  });

  describe("input validation", () => {
    it("returns INVALID_INPUT for slug with slashes", async () => {
      const result = await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "bad/slug",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toContain("bad/slug");
      }
    });

    it("returns INVALID_INPUT for slug with spaces", async () => {
      const result = await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "bad slug",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
      }
    });

    it("accepts slug with dots, hyphens, and underscores", async () => {
      const result = await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "my-slug_v1.0",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("HTTP server not running", () => {
    it("returns UNEXPECTED when HTTP server is not running", async () => {
      vi.mocked(isHttpServerRunning).mockReturnValue(false);

      const result = await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "slug",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("UNEXPECTED");
        expect(result.recoverable).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // DEC-05: daemon-active state seeded — artifact URLs resolve to daemon port
  // ---------------------------------------------------------------------------
  describe("DEC-05 — daemon-active state seeded", () => {
    const DAEMON_PORT = 3142;

    beforeEach(() => {
      // Simulate the daemon calling setHttpPort(3142) + markDaemonArtifactActive()
      // In the real system, daemon.ts calls these at startDaemon() time.
      // Here we seed the mock state to reflect post-daemon-startup conditions.
      vi.mocked(isHttpServerRunning).mockReturnValue(true);
      vi.mocked(getHttpPort).mockReturnValue(DAEMON_PORT);
    });

    afterEach(() => {
      vi.resetAllMocks();
      // Restore defaults for subsequent tests
      vi.mocked(isHttpServerRunning).mockReturnValue(true);
      vi.mocked(getHttpPort).mockReturnValue(3457);
    });

    it("resolves artifact URL to the daemon port (3142) when daemon-active", async () => {
      const result = await presentArtifact({
        data: {},
        html: "<html><body>Artifact</body></html>",
        slug: "my-artifact",
        type: "design",
        workspace: "/ws",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toContain(`:${DAEMON_PORT}/`);
        expect(result.url).toContain("design/my-artifact");
      }
    });

    it("does NOT return UNEXPECTED when daemon-active (isHttpServerRunning = true via DEC-05)", async () => {
      const result = await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "test-slug",
        type: "review",
        workspace: "/ws",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        // If it returns an error, it must NOT be UNEXPECTED
        expect(result.error_code).not.toBe("UNEXPECTED");
      }
    });

    it("registers the artifact (delegates to registerArtifact) in daemon mode", async () => {
      const html = "<html>Review in daemon mode</html>";
      const data = { has_review: true };

      await presentArtifact({
        data,
        html,
        slug: "daemon-review",
        type: "review",
        workspace: "/ws",
      });

      expect(registerArtifact).toHaveBeenCalledWith("review/daemon-review", html, data);
    });
  });
});
