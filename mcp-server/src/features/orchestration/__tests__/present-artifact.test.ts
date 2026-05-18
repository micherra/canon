/**
 * Tests for present-artifact.ts
 *
 * Verifies behavior after VIEW_MAP was emptied (planning-brief entry removed).
 * The primary use path is now html-bypass (caller passes html string directly).
 */

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

vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";
import { isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
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

  describe("html bypass path (primary use case)", () => {
    it("serves inline html directly without VIEW_MAP lookup", async () => {
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

    it("does not call readFile when html is provided", async () => {
      await presentArtifact({
        data: {},
        html: "<html/>",
        slug: "slug",
        type: "any-type",
        workspace: "/ws",
      });

      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe("VIEW_MAP is empty — no compiled view types", () => {
    it("returns INVALID_INPUT for planning-brief type (removed from VIEW_MAP)", async () => {
      const result = await presentArtifact({
        data: {},
        slug: "my-slug",
        type: "planning-brief",
        workspace: "/ws",
        // no html — uses VIEW_MAP path
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toContain("planning-brief");
      }
    });

    it("error message lists empty known types when VIEW_MAP is empty", async () => {
      const result = await presentArtifact({
        data: {},
        slug: "s",
        type: "planning-brief",
        workspace: "/ws",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Known types: <empty string> since VIEW_MAP has no entries
        expect(result.message).toMatch(/Known types:/);
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
});
