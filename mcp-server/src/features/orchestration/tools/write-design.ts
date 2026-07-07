import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { emitWriteReceipt } from "../services/write-receipt.ts";

/**
 * write_design — thin persist-and-receipt tool for the architect's DESIGN.md.
 *
 * The architect still authors the markdown (this tool does not move template
 * logic server-side — see `templates/design-document.md`); this tool owns the
 * canonical path (`plans/{slug}/DESIGN.md`) and emits the `design` write
 * receipt the write-receipt completion gate requires (wrgate-06/ADR-0042).
 */
export type WriteDesignInput = {
  workspace: string;
  slug: string;
  content: string;
};

export type WriteDesignResult = {
  path: string;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writeDesign(input: WriteDesignInput): Promise<ToolResult<WriteDesignResult>> {
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
  const designPath = join(plansDir, "DESIGN.md");
  await writeFile(designPath, input.content, "utf-8");

  emitWriteReceipt(input.workspace, {
    artifact_kind: "design",
    artifact_path: designPath,
    slug: input.slug,
  });

  return toolOk({ path: designPath });
}
