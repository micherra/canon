import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "../shared/lib/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export type WriteTestReportInput = {
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
};

export type WriteTestReportResult = {
  path: string;
  meta_path: string;
  total: number;
  pass_rate: number;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Validate input fields and resolve the plans directory. Returns error or plansDir. */
function validateReportInput(input: WriteTestReportInput): ToolResult<{ plansDir: string }> {
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
  const plansDir = resolve(join(input.workspace, "plans", input.slug));
  const plansRoot = resolve(join(input.workspace, "plans"));
  const rel = relative(plansRoot, plansDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError(
      "INVALID_INPUT",
      `Slug "${input.slug}" resolves outside workspace plans directory`,
    );
  }
  for (const [field, value] of [
    ["passed", input.passed],
    ["failed", input.failed],
    ["skipped", input.skipped],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      return toolError("INVALID_INPUT", `"${field}" must be a non-negative integer, got ${value}`);
    }
  }
  return toolOk({ plansDir });
}

/** Generate the markdown content for the test report. */
function generateReportMarkdown(
  input: WriteTestReportInput,
  total: number,
  passRate: number,
): string {
  const passRateDisplay = `${(passRate * 100).toFixed(1)}%`;
  const statsHeader = "| Passed | Failed | Skipped | Total | Pass Rate |";
  const statsSeparator = "|--------|--------|---------|-------|-----------|";
  const statsRow = `| ${input.passed} | ${input.failed} | ${input.skipped} | ${total} | ${passRateDisplay} |`;

  let content = `## Test Report\n\n${input.summary}\n\n${statsHeader}\n${statsSeparator}\n${statsRow}\n`;

  const issues = input.issues ?? [];
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
  return content;
}

export async function writeTestReport(
  input: WriteTestReportInput,
): Promise<ToolResult<WriteTestReportResult>> {
  const validation = validateReportInput(input);
  if (!validation.ok) return validation;
  const { plansDir } = validation;

  const total = input.passed + input.failed + input.skipped;
  const pass_rate = total > 0 ? input.passed / total : 0;
  const content = generateReportMarkdown(input, total, pass_rate);

  await mkdir(plansDir, { recursive: true });
  const reportPath = join(plansDir, "TEST-REPORT.md");
  const metaPath = join(plansDir, "TEST-REPORT.meta.json");

  await writeFile(reportPath, content, "utf-8");
  const meta = {
    _type: "test_report",
    _version: 1,
    failed: input.failed,
    issues: input.issues ?? [],
    pass_rate,
    passed: input.passed,
    skipped: input.skipped,
    summary: input.summary,
    total,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({ meta_path: metaPath, pass_rate, path: reportPath, total });
}
