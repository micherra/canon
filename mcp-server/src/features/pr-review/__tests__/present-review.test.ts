/**
 * Tests for present-review.ts
 *
 * Verifies the new file-read implementation: read review.html → showPrImpact (data enrichment) → presentArtifact
 * All I/O-dependent collaborators are mocked with vi.mock.
 */

import type { PresentArtifactResult } from "@features/orchestration/tools/present-artifact.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedPrOutput } from "../tools/show-pr-impact.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises");
vi.mock("../tools/show-pr-impact.ts");
vi.mock("@features/orchestration/tools/present-artifact.ts");

import { access, readFile } from "node:fs/promises";
import { presentArtifact } from "@features/orchestration/tools/present-artifact.ts";
import { presentReview } from "../tools/present-review.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";

// readFile overloads are complex — utf-8 encoding returns string but vi.mocked types expect Buffer.
// Cast through `as any` once here so each test call site is clean.
type ReadFileResult = ReturnType<typeof readFile> extends Promise<infer R> ? R : never;
const mockReadFile = (content: string) =>
  vi.mocked(readFile).mockResolvedValue(content as ReadFileResult);

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

const MOCK_HTML = "<html><body>Agent-Generated Review Dashboard</body></html>";

const MOCK_ARTIFACT_RESULT: ToolResult<PresentArtifactResult> = {
  decision: { action: "approve", annotations: [] },
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

  describe("happy path — review.html exists", () => {
    it("reads review.html, calls showPrImpact, and calls presentArtifact", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      const result = await presentReview(
        { slug: "test-slug", workspace: "/workspace/main" },
        "/project",
      );

      expect(result).toEqual(MOCK_ARTIFACT_RESULT);
      expect(access).toHaveBeenCalledOnce();
      expect(readFile).toHaveBeenCalledOnce();
      expect(showPrImpact).toHaveBeenCalledOnce();
      expect(presentArtifact).toHaveBeenCalledOnce();
    });

    it("checks for review.html at the correct path", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(access).toHaveBeenCalledWith("/ws/artifacts/review.html");
    });

    it("reads review.html as utf-8", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(readFile).toHaveBeenCalledWith("/ws/artifacts/review.html", "utf-8");
    });

    it("passes projectDir and options to showPrImpact", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
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

    it("passes agent HTML and prImpact data to presentArtifact", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
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

    it("returns the decision and url from presentArtifact", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result).toMatchObject({
        decision: { action: "approve", annotations: [] },
        ok: true,
        url: expect.stringContaining("review-result"),
      });
    });
  });

  describe("error: review.html does not exist", () => {
    it("returns INVALID_INPUT error when review.html is missing", async () => {
      vi.mocked(access).mockRejectedValue(new Error("ENOENT"));

      const result = await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
        expect(result.recoverable).toBe(true);
      }
    });

    it("does not call showPrImpact or presentArtifact when review.html is missing", async () => {
      vi.mocked(access).mockRejectedValue(new Error("ENOENT"));

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(readFile).not.toHaveBeenCalled();
      expect(showPrImpact).not.toHaveBeenCalled();
      expect(presentArtifact).not.toHaveBeenCalled();
    });
  });

  describe("error propagation from presentArtifact", () => {
    it("propagates errors returned by presentArtifact", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      const artifactError: ToolResult<PresentArtifactResult> = {
        error_code: "UNEXPECTED",
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

    it("does not call access when input validation fails", async () => {
      await presentReview({ slug: "slug", workspace: "" }, "/proj");

      expect(access).not.toHaveBeenCalled();
      expect(showPrImpact).not.toHaveBeenCalled();
    });
  });

  describe("optional parameters", () => {
    it("passes undefined branch and pr_number when not provided", async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      mockReadFile(MOCK_HTML);
      vi.mocked(showPrImpact).mockResolvedValue(MOCK_UNIFIED_OUTPUT);
      vi.mocked(presentArtifact).mockResolvedValue(MOCK_ARTIFACT_RESULT);

      await presentReview({ slug: "slug", workspace: "/ws" }, "/proj");

      expect(showPrImpact).toHaveBeenCalledWith("/proj", {
        branch: undefined,
        pr_number: undefined,
      });
    });
  });
});
