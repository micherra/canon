/**
 * Builds the shared prompt cache prefix written at workspace creation.
 *
 * Extracted from init-workspace.ts to keep that file under the 600-line limit.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";

async function tryReadFileContent(path: string, label: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    console.warn(`[canon] ${label} read failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

type CachePrefixInput = { task: string; branch: string; base_commit: string; flow_name: string };

/** Build the shared prompt cache prefix. */
export async function buildCachePrefix(
  input: CachePrefixInput,
  options: {
    slug: string;
    flowName?: string;
    projectDir: string;
    pluginDir: string;
  },
): Promise<string> {
  const { slug, flowName, projectDir, pluginDir } = options;
  const prefixParts: string[] = [];
  prefixParts.push(`## Flow: ${flowName ?? input.flow_name}`);

  const claudeMd = await tryReadFileContent(join(pluginDir, "CLAUDE.md"), "cache prefix CLAUDE.md");
  if (claudeMd) prefixParts.push(claudeMd);

  prefixParts.push(
    `## Workspace\n\n- Task: ${input.task}\n- Branch: ${input.branch}\n- Slug: ${slug}\n- Base commit: ${input.base_commit}`,
  );

  const conventions = await tryReadFileContent(
    join(projectDir, CANON_DIR, "CONVENTIONS.md"),
    "conventions",
  );
  if (conventions) prefixParts.push(`## Conventions\n\n${conventions}`);

  return prefixParts.join("\n\n---\n\n");
}
