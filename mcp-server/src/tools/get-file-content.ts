/** Read a file within the project directory, with path traversal protection. */

import { readFile } from "fs/promises";
import { resolve, isAbsolute } from "path";
import { z } from "zod";
import { isNotFound } from "../utils/errors.js";

export const GetFileContentInputSchema = z.object({
  file_path: z.string().min(1).describe("Project-relative file path"),
});

export type GetFileContentInput = z.infer<typeof GetFileContentInputSchema>;

export interface GetFileContentOutput {
  content: string | null;
  path: string | null;
  error?: string;
}

/**
 * Resolve a project-relative path safely.  Returns null on traversal attempts
 * (absolute paths, ".." segments, or escaping project dir).
 */
export function safeResolvePath(projectDir: string, filePath: string): string | null {
  if (isAbsolute(filePath)) return null;
  if (filePath.includes("..")) return null;
  const resolved = resolve(projectDir, filePath);
  // Ensure the resolved path is still within projectDir
  if (!resolved.startsWith(projectDir + "/") && resolved !== projectDir) return null;
  return resolved;
}

export async function getFileContent(
  input: GetFileContentInput,
  projectDir: string,
): Promise<GetFileContentOutput> {
  const parsed = GetFileContentInputSchema.safeParse(input);
  if (!parsed.success) {
    return { content: null, path: null, error: "Invalid input" };
  }

  const { file_path } = parsed.data;

  const resolved = safeResolvePath(projectDir, file_path);
  if (!resolved) {
    return { content: null, path: null, error: "Path traversal rejected" };
  }

  try {
    const content = await readFile(resolved, "utf-8");
    return { content, path: file_path };
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return { content: null, path: file_path, error: "File not found" };
    }
    return { content: null, path: file_path, error: "Read error" };
  }
}
