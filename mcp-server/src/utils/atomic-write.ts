/**
 * Atomic file write — writes to a temp file in the same directory, then renames.
 * rename() within the same filesystem is atomic on POSIX, preventing partial reads.
 */

import { writeFile, rename, unlink } from "fs/promises";

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    await writeFile(tmpPath, data, "utf-8");
    try {
      await rename(tmpPath, filePath);
    } catch (renameErr: any) {
      // On Windows, rename() fails with EPERM when dest exists — remove dest and retry
      if (renameErr.code === "EPERM") {
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
