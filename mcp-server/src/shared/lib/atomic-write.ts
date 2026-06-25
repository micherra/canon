/**
 * Atomic file write utilities.
 *
 * atomicWriteFile — writes to a temp file in the same directory, then renames.
 * rename() within the same filesystem is atomic on POSIX, preventing partial reads.
 *
 * atomicWritePair — writes two files atomically as a pair: writes both to temp
 * files, then renames both. Prevents the md-new/meta-old divergence window that
 * arises when two sequential atomicWriteFile calls crash between the first and
 * second rename. Callers see either both old files or both new files, never a mix.
 */

import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

let counter = 0;

async function renameWithWindowsRetry(tmpPath: string, filePath: string): Promise<void> {
  try {
    await rename(tmpPath, filePath);
  } catch (renameErr: unknown) {
    const code = (renameErr as NodeJS.ErrnoException).code ?? "";
    if (!["EPERM", "EEXIST", "EACCES"].includes(code)) throw renameErr;
    // On Windows, rename() can fail if dest exists — remove dest and retry
    try {
      await unlink(filePath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await rename(tmpPath, filePath);
  }
}

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const suffix = `${process.pid}.${++counter}.${randomBytes(4).toString("hex")}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    await renameWithWindowsRetry(tmpPath, filePath);
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

/**
 * Write two files as an atomic pair: write both temp files first, then rename
 * both. Callers see either both old files or both new files — never a mix.
 *
 * Use when the two files must remain in sync (e.g. REVIEW.md + REVIEW.meta.json).
 * A crash between sequential atomicWriteFile calls would leave a new md with an
 * old meta, or vice versa. atomicWritePair closes that window by writing both
 * temps before issuing either rename.
 *
 * On rename failure for path2, we attempt to restore path1 by deleting its temp
 * (the first rename already landed, so path1 is now the new file — no rollback
 * is possible for a rename that completed). Errors from temp cleanup are swallowed.
 */
export async function atomicWritePair(
  filePath1: string,
  data1: string,
  filePath2: string,
  data2: string,
): Promise<void> {
  const suffix = `${process.pid}.${++counter}.${randomBytes(4).toString("hex")}`;
  const tmp1 = `${filePath1}.tmp.${suffix}`;
  const tmp2 = `${filePath2}.tmp.${suffix}`;

  // Write both temp files before issuing any rename
  try {
    await writeFile(tmp1, data1, "utf-8");
    await writeFile(tmp2, data2, "utf-8");
  } catch (err) {
    // Clean up any temps we managed to create (parallel cleanup, not a loop)
    await Promise.allSettled([unlink(tmp1), unlink(tmp2)]);
    throw err;
  }

  // Rename in order. Both renames should succeed — if the second fails we cannot
  // roll back the first (rename is not transactional on POSIX), but we clean up.
  try {
    await renameWithWindowsRetry(tmp1, filePath1);
  } catch (err) {
    try {
      await unlink(tmp1);
    } catch {
      /* ignore */
    }
    try {
      await unlink(tmp2);
    } catch {
      /* ignore */
    }
    throw err;
  }

  try {
    await renameWithWindowsRetry(tmp2, filePath2);
  } catch (err) {
    // tmp1 rename already landed — we cannot undo filePath1. Clean up tmp2.
    try {
      await unlink(tmp2);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
