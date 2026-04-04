import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

/** Escape a value for safe inclusion in a markdown table cell. */
const escapeMdCell = (value: string): string =>
  value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");

export type WriteResearchSynthesisInput = {
  workspace: string;
  slug: string;
  key_findings: Array<{
    finding: string;
    confidence: "high" | "medium" | "low";
    source?: string;
  }>;
  affected_subsystems: string[];
  risk_areas: Array<{
    area: string;
    severity: "high" | "medium" | "low";
    mitigation?: string;
  }>;
  open_questions: string[];
  sources?: string[];
};

export type WriteResearchSynthesisResult = {
  path: string;
  meta_path: string;
  finding_count: number;
  risk_count: number;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateInput(input: WriteResearchSynthesisInput): ToolResult<{ handoffsDir: string }> {
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
  const handoffsDir = resolve(join(input.workspace, "handoffs"));
  const workspaceResolved = resolve(input.workspace);
  if (!handoffsDir.startsWith(`${workspaceResolved}/`) && handoffsDir !== workspaceResolved) {
    return toolError("INVALID_INPUT", `Handoffs directory resolves outside workspace`);
  }
  return toolOk({ handoffsDir });
}

function generateFindingsSection(input: WriteResearchSynthesisInput): string {
  const header = "| Finding | Confidence | Source |";
  const separator = "|---------|------------|--------|";
  const rows = input.key_findings.map((f) => {
    const source = f.source ? escapeMdCell(f.source) : "—";
    return `| ${escapeMdCell(f.finding)} | ${f.confidence} | ${source} |`;
  });
  return `### Key Findings\n\n${header}\n${separator}\n${rows.join("\n")}\n`;
}

function generateRiskSection(input: WriteResearchSynthesisInput): string {
  const header = "| Area | Severity | Mitigation |";
  const separator = "|------|----------|------------|";
  const rows = input.risk_areas.map((r) => {
    const mitigation = r.mitigation ? escapeMdCell(r.mitigation) : "—";
    return `| ${escapeMdCell(r.area)} | ${r.severity} | ${mitigation} |`;
  });
  return `### Risk Areas\n\n${header}\n${separator}\n${rows.join("\n")}\n`;
}

function generateMarkdown(input: WriteResearchSynthesisInput): string {
  const lines: string[] = [`## Research Synthesis: ${input.slug}`, ""];

  lines.push(generateFindingsSection(input), "");

  lines.push("### Affected Subsystems", "");
  for (const subsystem of input.affected_subsystems) lines.push(`- ${subsystem}`);
  lines.push("");

  lines.push(generateRiskSection(input), "");

  lines.push("### Open Questions", "");
  for (const q of input.open_questions) lines.push(`- ${q}`);
  lines.push("");

  if (input.sources && input.sources.length > 0) {
    lines.push("### Sources", "");
    for (const s of input.sources) lines.push(`- ${s}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeResearchSynthesis(
  input: WriteResearchSynthesisInput,
): Promise<ToolResult<WriteResearchSynthesisResult>> {
  const validation = validateInput(input);
  if (!validation.ok) return validation;
  const { handoffsDir } = validation;

  const content = generateMarkdown(input);
  const meta: Record<string, unknown> = {
    _type: "research_synthesis",
    _version: 1,
    affected_subsystems: input.affected_subsystems,
    key_findings: input.key_findings,
    open_questions: input.open_questions,
    risk_areas: input.risk_areas,
    slug: input.slug,
  };
  if (input.sources !== undefined) meta.sources = input.sources;

  await mkdir(handoffsDir, { recursive: true });
  const synthPath = join(handoffsDir, "RESEARCH-SYNTHESIS.md");
  const metaPath = join(handoffsDir, "RESEARCH-SYNTHESIS.meta.json");

  await writeFile(synthPath, content, "utf-8");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return toolOk({
    finding_count: input.key_findings.length,
    meta_path: metaPath,
    path: synthPath,
    risk_count: input.risk_areas.length,
  });
}
