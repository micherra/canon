/**
 * Atomic file write — writes to a temp file in the same directory, then renames.
 * rename() within the same filesystem is atomic on POSIX, preventing partial reads.
 */

import { writeFile, rename, unlink } from "fs/promises";
import { randomBytes } from "crypto";

let counter = 0;

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const suffix = `${process.pid}.${++counter}.${randomBytes(4).toString("hex")}`;
  const tmpPath = filePath + ".tmp." + suffix;
  try {
    await writeFile(tmpPath, data, "utf-8");
    try {
      await rename(tmpPath, filePath);
    } catch (renameErr: any) {
      // On Windows, rename() can fail with EPERM/EEXIST/EACCES when dest exists — remove dest and retry
      if (renameErr.code === "EPERM" || renameErr.code === "EEXIST" || renameErr.code === "EACCES") {
        try { await unlink(filePath); } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
        await rename(tmpPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    // Clean up temp file on failure
    try { await unlink(tmpPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}
