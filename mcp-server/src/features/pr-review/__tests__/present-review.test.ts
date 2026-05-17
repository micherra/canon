/**
 * Tests for present-review.ts
 *
 * Verifies the composition: showPrImpact → readFile (pre-rendered HTML) → presentArtifact
 * All I/O-dependent collaborators are mocked with vi.mock.
 */

import type { PresentArtifactResult } from "@features/orchestration/tools/present-artifact.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedPrOutput } from "../tools/show-pr-impact.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../tools/show-pr-impact.ts");
vi.mock("node:fs/promises");
vi.mock("@features/orchestration/tools/present-artifact.ts");

import { readFile } from "node:fs/promises";
import { presentArtifact } from "@features/orchestration/tools/present-artifact.ts";
import { presentReview } from "../tools/present-review.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_UNIFIED_OUTPUT: UnifiedPrOutput = {
  blast_radius_by_file: [],
  co_change_warnings: [],
  has_review: true,
  hotspots: [],
  prep: {
    blast_radius: [],
    diff_command: "git diff main..HEAD",
    files: [],
    impact_files: [],
    incremental: false,
    layers: [],
    narrative: "No changes",
    net_new_files: 0,
    total_files: 0,
    total_violations: 0,
  },
  status: "ok",
  subgraph: { edges: [], layers: [], nodes: [] },
  subsystems: [],
};

const MOCK_UNIFIED_NO_REVIEW: UnifiedPrOutput = {
  ...MOCK_UNIFIED_OUTPUT,
  has_review: false,
};

const MOCK_HTML = "<html><body>Review Dashboard</body></html>";

const MOCK_ARTIFACT_RESULT: ToolResult<PresentArtifactResult> = {
  ok: true,
  url: "http://127.0.0.1:3457/artifact/review-result/test-slug",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("presentReview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path — review HTML exists", () => {
    it("calls showPrImpact, reads HTML from disk, and calls presentArtifact in order", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      const result = await presentReview(
        { slug: "test-slug", workspace: "/workspace/main" },
        "/project",
      );

      expect(result).toEqual(MOCK_ARTIFACT_RESULT);

      // Verify call order via mock call sequence
      expect(showPrImpact).toHaveBeenCalledOnce();
      expect(readFile).toHaveBeenCalledOnce();
      expect(presentArtifact).toHaveBeenCalledOnce();
    });

    it("passes projectDir and options to showPrImpact", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview(
        { branch: "feat/x", pr_number: 42, slug: "my-slug", workspace: "/workspace" },
        "/my-project",
      );

      expect(showPrImpact).toHaveBeenCalledWith("/my-project", {
        branch: "feat/x",
        pr_number: 42,
      });
    });

    it("reads HTML from the correct path: ${workspace}/artifacts/review.html", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "slug", workspace: "/workspace/main" }, "/proj");

      expect(readFile).toHaveBeenCalledWith("/workspace/main/artifacts/review.html", "utf-8");
    });

    it("passes the file HTML and unified output to presentArtifact", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "my-slug", workspace: "/ws" }, "/proj");

      expect(presentArtifact).toHaveBeenCalledWith({
        data: MOCK_UNIFIED_OUTPUT,
        html: MOCK_HTML,
        slug: "my-slug",
        type: "review-result",
        workspace: "/ws",
      });
    });

    it("returns the url from presentArtifact", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result).toMatchObject({
        ok: true,
        url: expect.stringContaining("review-result"),
      });
    });
  });

  describe("error: missing HTML file", () => {
    it("returns INVALID_INPUT when review.html does not exist (ENOENT)", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      const enoentError = Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
      vi.mocked(readFile).mockRejectedValue(enoentError);

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toMatch(/review\.html/);
        expect(result.recoverable).toBe(true);
      }
    });

    it("includes the full HTML path in the error message", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const result = await presentReview({ slug: "slug", workspace: "/workspace/main" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("/workspace/main/artifacts/review.html");
      }
    });

    it("does not call presentArtifact when HTML file is missing", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(presentArtifact).not.toHaveBeenCalled();
    });
  });

  describe("error: no stored review", () => {
    it("returns INVALID_INPUT error when has_review is false", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_NO_REVIEW);

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toMatch(/store_pr_review/);
        expect(result.recoverable).toBe(true);
      }
    });

    it("does not call readFile or presentArtifact when no review exists", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_NO_REVIEW);

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(readFile).not.toHaveBeenCalled();
      expect(presentArtifact).not.toHaveBeenCalled();
    });
  });

  describe("error propagation from presentArtifact", () => {
    it("propagates errors returned by presentArtifact", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      const artifactError: ToolResult<PresentArtifactResult> = {
        error_code: "UNEXPECTED" as const,
        message: "HTTP server not running",
        ok: false,
        recoverable: true,
      };
      vi.mocked(presentArtifact).mockResolvedValue(artifactError);

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("UNEXPECTED");
        expect(result.message).toBe("HTTP server not running");
      }
    });
  });

  describe("input validation", () => {
    it("returns INVALID_INPUT when workspace is empty", async () => {
      const result = await presentReview({ slug: "slug", workspace: "" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toMatch(/workspace/);
      }
    });

    it("returns INVALID_INPUT when slug is empty", async () => {
      const result = await presentReview({ slug: "", workspace: "/ws" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.message).toMatch(/slug/);
      }
    });

    it("does not call showPrImpact when input validation fails", async () => {
      await presentReview({ slug: "slug", workspace: "" }, "/proj");

      expect(showPrImpact).not.toHaveBeenCalled();
    });
  });

  describe("optional parameters", () => {
    it("passes undefined branch and pr_number when not provided", async () => {
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(readFile).mockResolvedValue(MOCK_HTML as never);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(showPrImpact).toHaveBeenCalledWith("/proj", {
        branch: undefined,
        pr_number: undefined,
      });
    });
  });
});
