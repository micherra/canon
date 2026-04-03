import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface WriteReviewInput {
  workspace: string;
  slug: string;
  verdict: "approved" | "approved_with_concerns" | "changes_required" | "blocked";
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    description?: string;
    fix?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
  files: string[];
}

export interface WriteReviewResult {
  path: string;
  meta_path: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  violation_count: number;
}

export const VERDICT_MAP: Record<WriteReviewInput["verdict"], "BLOCKING" | "WARNING" | "CLEAN"> = {
  approved: "CLEAN",
  approved_with_concerns: "WARNING",
  changes_required: "WARNING",
  blocked: "BLOCKING",
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate normalized REVIEW.md content that is parseable by the existing
 * parseReviewArtifact function in orchestration/effects.ts.
 *
 * Format:
 * - YAML frontmatter with mapped verdict
 * - ## Canon Review — Verdict: {MAPPED}
 * - #### Violations table (principle_id | severity | file_path)
 * - #### Honored list (- **principle_id**)
 * - #### Score table (layer | rules | opinions | conventions)
 */
function generateMarkdown(input: WriteReviewInput, mappedVerdict: "BLOCKING" | "WARNING" | "CLEAN"): string {
  const lines: string[] = [];

  // YAML frontmatter — parseReviewArtifact matches /verdict:\s*"?(BLOCKING|WARNING|CLEAN)"?/i
  lines.push("---");
  lines.push(`verdict: ${mappedVerdict}`);
  lines.push("---");
  lines.push("");

  // Heading — parseReviewArtifact matches /## Canon Review — Verdict:\s*(BLOCKING|WARNING|CLEAN)/i
  lines.push(`## Canon Review — Verdict: ${mappedVerdict}`);
  lines.push("");

  // Violations section — parseReviewArtifact regex:
  // /#### Violations\s*\n(?:<!--.*?-->\s*\n)?\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/
  // Cells parsed: [0]=principle_id, [1]=severity, [2]=file_path (before colon, backticks stripped)
  lines.push("#### Violations");
  lines.push("");
  lines.push("| Principle | Severity | Location |");
  lines.push("|-----------|----------|----------|");
  for (const v of input.violations) {
    const filePath = v.file_path ?? "";
    lines.push(`| ${escapeMdCell(v.principle_id)} | ${escapeMdCell(v.severity)} | ${escapeMdCell(filePath)} |`);
  }
  lines.push("");

  // Honored section — parseReviewArtifact regex:
  // /#### Honored\s*\n(?:<!--.*?-->\s*\n)?((?:- \*\*.*\n)*)/
  // Extracts: /- \*\*([^*]+)\*\*/
  lines.push("#### Honored");
  lines.push("");
  for (const id of input.honored) {
    lines.push(`- **${id}**`);
  }
  lines.push("");

  // Score section — parseReviewArtifact regex:
  // /#### Score\s*\n\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/
  // Cells: [0]=layer, [1]=rules "P / T", [2]=opinions "P / T", [3]=conventions "P / T"
  // Scores are aggregated across all rows
  lines.push("#### Score");
  lines.push("");
  lines.push("| Layer | Rules | Opinions | Conventions |");
  lines.push("|-------|-------|----------|-------------|");
  lines.push(
    `| overall | ${input.score.rules.passed} / ${input.score.rules.total} | ${input.score.opinions.passed} / ${input.score.opinions.total} | ${input.score.conventions.passed} / ${input.score.conventions.total} |`,
  );
  lines.push("");

  return lines.join("\n");
}

export async function writeReview(
  input: WriteReviewInput,
): Promise<ToolResult<WriteReviewResult>> {
  // Validate slug
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // Validate path traversal safety
  const reviewsDir = resolve(join(input.workspace, "reviews"));
  const workspaceResolved = resolve(input.workspace);
  const rel = relative(workspaceResolved, reviewsDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Workspace resolves outside expected path`,
    );
  }

  // Map verdict
  const mappedVerdict = VERDICT_MAP[input.verdict];

  // Generate markdown
  const markdown = generateMarkdown(input, mappedVerdict);

  // Write files
  await mkdir(reviewsDir, { recursive: true });
  const reviewPath = join(reviewsDir, "REVIEW.md");
  const metaPath = join(reviewsDir, "REVIEW.meta.json");

  await writeFile(reviewPath, markdown, "utf-8");

  const meta = {
    _type: "review" as const,
    _version: 1,
    verdict_original: input.verdict,
    verdict: mappedVerdict,
    violations: input.violations,
    honored: input.honored,
    score: input.score,
    files: input.files,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    path: reviewPath,
    meta_path: metaPath,
    verdict: mappedVerdict,
    violation_count: input.violations.length,
  });
}
