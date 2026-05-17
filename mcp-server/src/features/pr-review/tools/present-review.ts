/**
 * present_review — MCP tool handler
 *
 * Composes two existing functions + a file read into an end-to-end flow:
 *   1. showPrImpact     — reads stored review from DriftStore, enriches with KG data
 *   2. readFile          — reads agent-generated HTML from ${workspace}/artifacts/review.html
 *   3. presentArtifact  — serves HTML via HTTP server, opens browser, blocks until decision
 *
 * The review must already be stored in DriftStore (via store_pr_review) before calling
 * this tool. showPrImpact reads from DriftStore to get review-enriched data.
 *
 * Canon principles:
 *   - functions-do-one-thing: thin composition layer — no HTML generation, no data transformation
 *   - deep-modules: four-param interface hiding multi-step data assembly
 *   - no-hidden-side-effects: opens a browser and blocks — documented in tool description
 *   - validate-at-trust-boundaries: validates input params; composed functions handle internals
 *   - consistent-abstraction-levels: three calls at the same level — no low-level details
 */

import { readFile } from "node:fs/promises";
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
 * Wire showPrImpact → readFile (pre-rendered HTML) → presentArtifact into a single MCP tool call.
 *
 * Requires a stored review in DriftStore (via store_pr_review) before calling.
 * Requires pre-rendered HTML at ${workspace}/artifacts/review.html (via the renderer agent).
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

  // 1. Get unified review data from DriftStore + KG enrichment
  const prImpact = await showPrImpact(projectDir, {
    branch: input.branch,
    pr_number: input.pr_number,
  });

  // Check if a stored Canon review exists — showPrImpact degrades gracefully when no review
  if (!prImpact.has_review) {
    return toolError(
      "INVALID_INPUT",
      "No stored review found. Run store_pr_review before present_review.",
      true,
    );
  }

  // 2. Read pre-rendered HTML from workspace artifacts
  const htmlPath = join(input.workspace, "artifacts", "review.html");
  let html: string;
  try {
    html = await readFile(htmlPath, "utf-8");
  } catch {
    return toolError(
      "INVALID_INPUT",
      `Review HTML not found at ${htmlPath}. Run the renderer before calling present_review.`,
      true,
    );
  }

  // 3. Present in browser and block until decision
  return presentArtifact({
    data: prImpact,
    html,
    slug: input.slug,
    type: "review-result",
    workspace: input.workspace,
  });
}
