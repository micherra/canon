/**
 * Atomic file write — writes to a temp file in the same directory, then renames.
 * rename() within the same filesystem is atomic on POSIX, preventing partial reads.
 */

import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

let counter = 0;

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const suffix = `${process.pid}.${++counter}.${randomBytes(4).toString("hex")}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    try {
      await rename(tmpPath, filePath);
    } catch (renameErr: unknown) {
      // On Windows, rename() can fail if dest exists — remove dest and retry
      const isWindowsLocked = ["EPERM", "EEXIST", "EACCES"].includes((renameErr as NodeJS.ErrnoException).code ?? "");
      if (isWindowsLocked) {
        try {
          await unlink(filePath);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await rename(tmpPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
