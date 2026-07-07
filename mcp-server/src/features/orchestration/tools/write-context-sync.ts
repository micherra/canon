import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { emitWriteReceipt } from "../services/write-receipt.ts";

/**
 * write_context_sync — thin persist-and-receipt tool for the scribe's
 * CONTEXT-SYNC.md.
 *
 * The scribe still authors the markdown (see `templates/context-sync.md`);
 * this tool owns the canonical path (`plans/{slug}/CONTEXT-SYNC.md`) and
 * emits the `context_sync` write receipt the write-receipt completion gate
 * requires (ADR-0042). Emits on BOTH `status` values — a NO_UPDATES sync
 * still produces the file, so it must still receipt (no false-close).
 */
export type WriteContextSyncInput = {
  workspace: string;
  slug: string;
  content: string;
  status: "UPDATED" | "NO_UPDATES";
};

export type WriteContextSyncResult = {
  path: string;
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function writeContextSync(
  input: WriteContextSyncInput,
): Promise<ToolResult<WriteContextSyncResult>> {
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
  const syncPath = join(plansDir, "CONTEXT-SYNC.md");
  await writeFile(syncPath, input.content, "utf-8");

  emitWriteReceipt(input.workspace, {
    artifact_kind: "context_sync",
    artifact_path: syncPath,
    slug: input.slug,
  });

  return toolOk({ path: syncPath });
}
