import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { emitWriteReceipt } from "../services/write-receipt.ts";

/**
 * write_security_assessment — thin persist-and-receipt tool for the
 * security agent's SECURITY.md.
 *
 * The security agent still authors the markdown (see
 * `templates/security-assessment.md`); this tool owns the canonical path
 * (`plans/{slug}/SECURITY.md`) and emits the `security_assessment` write
 * receipt the write-receipt completion gate requires (ADR-0043).
 */
export type WriteSecurityAssessmentInput = {
  workspace: string;
  slug: string;
  content: string;
};

export type WriteSecurityAssessmentResult = {
  path: string;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writeSecurityAssessment(
  input: WriteSecurityAssessmentInput,
): Promise<ToolResult<WriteSecurityAssessmentResult>> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }
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

  await mkdir(plansDir, { recursive: true });
  const assessmentPath = join(plansDir, "SECURITY.md");
  await writeFile(assessmentPath, input.content, "utf-8");

  emitWriteReceipt(input.workspace, {
    artifact_kind: "security_assessment",
    artifact_path: assessmentPath,
    content: input.content,
    slug: input.slug,
  });

  return toolOk({ path: assessmentPath });
}
