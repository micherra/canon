/**
 * present_review — MCP tool handler
 *
 * Reads agent-generated review HTML from disk and presents it in the browser:
 *   1. Read ${workspace}/artifacts/review.html (written by the reviewer agent)
 *   2. showPrImpact — reads stored review from DriftStore, enriches with KG data (window.__CANON_DATA__)
 *   3. presentArtifact  — serves HTML via HTTP server, opens browser, blocks until decision
 *
 * Canon principles:
 *   - functions-do-one-thing: reads agent HTML and presents it — no HTML generation
 *   - validate-at-trust-boundaries: validates inputs and checks review.html exists before reading
 *   - simplicity-first: 936-line server-side HTML generator replaced by a file read
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PresentArtifactResult } from "@features/orchestration/tools/present-artifact.ts";
import { presentArtifact } from "@features/orchestration/tools/present-artifact.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { showPrImpact } from "./show-pr-impact.ts";

export type PresentReviewInput = {
  workspace: string;
  slug: string;
  branch?: string;
  pr_number?: number;
};

export type PresentReviewResult = PresentArtifactResult;

/**
 * Wire file read → showPrImpact (data enrichment) → presentArtifact into a single MCP tool call.
 *
 * Requires the reviewer agent to have written review.html to ${workspace}/artifacts/review.html.
 * Opens the browser and blocks until the user submits a decision.
 */
export async function presentReview(
  input: PresentReviewInput,
  projectDir: string,
): Promise<ToolResult<PresentReviewResult>> {
  // Validate required input fields at the trust boundary
  if (!input.workspace || typeof input.workspace !== "string") {
    return toolError("INVALID_INPUT", "workspace is required and must be a string", false);
  }
  if (!input.slug || typeof input.slug !== "string") {
    return toolError("INVALID_INPUT", "slug is required and must be a string", false);
  }

  // 1. Read agent-generated review HTML
  const htmlPath = join(input.workspace, "artifacts", "review.html");
  try {
    await access(htmlPath);
  } catch {
    return toolError(
      "INVALID_INPUT",
      `No review HTML found at ${input.workspace}/artifacts/review.html. The reviewer agent must produce this artifact.`,
      true,
    );
  }
  const html = await readFile(htmlPath, "utf-8");

  // 2. Get data enrichment for window.__CANON_DATA__
  const prImpact = await showPrImpact(projectDir, {
    branch: input.branch,
    pr_number: input.pr_number,
  });

  // 3. Present in browser and block until decision
  return presentArtifact({
    data: prImpact,
    html,
    slug: input.slug,
    type: "review-result",
    workspace: input.workspace,
  });
}
