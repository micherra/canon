import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface WriteTestReportInput {
  workspace: string;
  slug: string;
  summary: string;
  passed: number;
  failed: number;
  skipped: number;
  issues?: Array<{
    test: string;
    error: string;
    category?: string;
    file?: string;
  }>;
}

export interface WriteTestReportResult {
  path: string;
  meta_path: string;
  total: number;
  pass_rate: number;
}

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writeTestReport(
  input: WriteTestReportInput,
): Promise<ToolResult<WriteTestReportResult>> {
  // Validate slug
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // Validate path traversal
  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const plansRoot = resolve(join(input.workspace, "plans"));
  const rel = relative(plansRoot, plansDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Slug "${input.slug}" resolves outside workspace plans directory`,
    );
  }

  // Validate passed/failed/skipped are non-negative integers
  for (const [field, value] of [["passed", input.passed], ["failed", input.failed], ["skipped", input.skipped]] as const) {
    if (!Number.isInteger(value) || value < 0) {
      return toolError(
        "INVALID_INPUT",
        `"${field}" must be a non-negative integer, got ${value}`,
      );
    }
  }

  // Compute derived fields
  const total = input.passed + input.failed + input.skipped;
  const pass_rate = total > 0 ? input.passed / total : 0;
  const issues = input.issues ?? [];

  // Build pass_rate display string (e.g. "72.7%")
  const passRateDisplay = `${(pass_rate * 100).toFixed(1)}%`;

  // Generate normalized markdown
  const statsHeader = "| Passed | Failed | Skipped | Total | Pass Rate |";
  const statsSeparator = "|--------|--------|---------|-------|-----------|";
  const statsRow = `| ${input.passed} | ${input.failed} | ${input.skipped} | ${total} | ${passRateDisplay} |`;

  let content = `## Test Report\n\n${input.summary}\n\n${statsHeader}\n${statsSeparator}\n${statsRow}\n`;

  if (issues.length > 0) {
    const issuesHeader = "| Test | Error | Category | File |";
    const issuesSeparator = "|------|-------|----------|------|";
    const issueRows = issues.map((issue) => {
      const category = issue.category ?? "—";
      const file = issue.file ?? "—";
      return `| ${escapeMdCell(issue.test)} | ${escapeMdCell(issue.error)} | ${escapeMdCell(category)} | ${escapeMdCell(file)} |`;
    });
    content += `\n### Issues\n\n${issuesHeader}\n${issuesSeparator}\n${issueRows.join("\n")}\n`;
  }

  // Write files
  await mkdir(plansDir, { recursive: true });
  const reportPath = join(plansDir, "TEST-REPORT.md");
  const metaPath = join(plansDir, "TEST-REPORT.meta.json");

  await writeFile(reportPath, content, "utf-8");

  const meta = {
    _type: "test_report",
    _version: 1,
    summary: input.summary,
    passed: input.passed,
    failed: input.failed,
    skipped: input.skipped,
    total,
    pass_rate,
    issues,
  };

  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    path: reportPath,
    meta_path: metaPath,
    total,
    pass_rate,
  });
}
