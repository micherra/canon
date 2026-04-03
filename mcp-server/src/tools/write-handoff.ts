import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { toolOk, toolError, type ToolResult } from "../utils/tool-result.ts";
import { atomicWriteFile } from "../utils/atomic-write.ts";
import { assertWorkspacePath } from "../orchestration/execution-store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HandoffType = "research-synthesis" | "design-brief" | "impl-handoff" | "test-findings";

const ALLOWED_TYPES: HandoffType[] = [
  "research-synthesis",
  "design-brief",
  "impl-handoff",
  "test-findings",
];

export interface WriteHandoffResult {
  path: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Content schemas per handoff type
// ---------------------------------------------------------------------------

const researchSynthesisSchema = z.object({
  key_findings: z.string(),
  affected_subsystems: z.string(),
  risk_areas: z.string(),
  open_questions: z.string(),
});

const designBriefSchema = z.object({
  approach: z.string(),
  file_targets: z.string(),
  constraints: z.string(),
  test_expectations: z.string(),
});

const implHandoffSchema = z.object({
  files_changed: z.string(),
  coverage_notes: z.string(),
  risk_areas: z.string(),
  compliance_status: z.string(),
});

const testFindingsSchema = z.object({
  failure_details: z.string(),
  reproduction_steps: z.string(),
  affected_files: z.string(),
  categories: z.string(),
});

const CONTENT_SCHEMAS: Record<HandoffType, z.ZodObject<z.ZodRawShape>> = {
  "research-synthesis": researchSynthesisSchema,
  "design-brief": designBriefSchema,
  "impl-handoff": implHandoffSchema,
  "test-findings": testFindingsSchema,
};

// ---------------------------------------------------------------------------
// Input interface
// ---------------------------------------------------------------------------

export interface WriteHandoffInput {
  workspace: string;
  type: HandoffType;
  content: object;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Write a structured handoff markdown file to {workspace}/handoffs/{type}.md.
 * Each field in the type-specific content schema becomes a ## section.
 * Returns the resolved path and the type string.
 */
export async function writeHandoff(
  input: WriteHandoffInput,
): Promise<ToolResult<WriteHandoffResult>> {
  // Validate workspace path
  try {
    assertWorkspacePath(input.workspace);
  } catch {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Invalid workspace path: "${input.workspace}". Expected a path containing ".canon/workspaces/".`,
    );
  }

  // Validate type against allowed values
  if (!ALLOWED_TYPES.includes(input.type as HandoffType)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid handoff type "${String(input.type)}": must be one of ${ALLOWED_TYPES.join(", ")}`,
    );
  }

  // Validate content against the type-specific schema
  const schema = CONTENT_SCHEMAS[input.type];
  const parseResult = schema.safeParse(input.content);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => i.message).join("; ");
    return toolError(
      "INVALID_INPUT",
      `Content validation failed for type "${input.type}": ${issues}`,
    );
  }

  // Resolve and guard path against traversal outside handoffs/
  const handoffsRoot = resolve(join(input.workspace, "handoffs"));
  const resolvedPath = resolve(join(input.workspace, "handoffs", `${input.type}.md`));

  if (!resolvedPath.startsWith(handoffsRoot + sep) && resolvedPath !== handoffsRoot) {
    return toolError(
      "INVALID_INPUT",
      `Resolved path "${resolvedPath}" is outside the handoffs directory`,
    );
  }

  // Ensure handoffs directory exists (handles older workspaces missing the subdir)
  try {
    await mkdir(handoffsRoot, { recursive: true });
  } catch (err: unknown) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Cannot create handoffs directory at "${handoffsRoot}": ${(err as Error).message}`,
    );
  }

  // Render content fields as markdown sections
  const fields = parseResult.data as Record<string, string>;
  const sections = Object.entries(fields)
    .map(([key, value]) => `## ${key}\n\n${value}`)
    .join("\n\n");
  const markdown = `# ${input.type}\n\n${sections}\n`;

  try {
    await atomicWriteFile(resolvedPath, markdown);
  } catch (err: unknown) {
    return toolError(
      "UNEXPECTED",
      `Failed to write handoff file "${resolvedPath}": ${(err as Error).message}`,
    );
  }

  return toolOk({ path: resolvedPath, type: input.type });
}
