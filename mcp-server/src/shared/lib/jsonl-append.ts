/**
 * Newline-safe JSONL append primitive.
 *
 * Root cause this closes (PROBE-FINDINGS.md P1): an append that omits its
 * trailing newline leaves the file's last line "open" — the *next* append,
 * even a perfectly correct one, lands on that open line and the two records
 * merge into one unparseable line. The bug is not concurrency (P4 ruled a
 * race out with 200 concurrent appends producing 0 merges); it is a single
 * predecessor writer that forgot `\n`.
 *
 * `appendJsonlLine` closes this by reading the file's last byte before
 * appending and prefixing a healing `\n` when the predecessor left the line
 * open. It HEALS a bad predecessor rather than throwing — throwing here
 * would strand the record the caller asked to persist, turning a cosmetic
 * scar into data loss (`fail-closed-by-default` resolved in the fail-safe
 * direction: fail closed on what this module controls — an unserializable
 * record — not on damage it merely inherited). It fails closed only on a
 * record whose serialized form cannot be single-line, since a JSONL record
 * is single-line by definition.
 *
 * Deliberately NOT built on `atomicWriteFile`/`atomicWritePair`
 * (`./atomic-write.ts`). Those are write-temp-then-RENAME — rename
 * *replaces* the target file wholesale. That is correct for a file with one
 * current value (REVIEW.md, a config file) but is incompatible with
 * append-only data: a rename-based write can only ever encode "the last
 * writer wins," so any append that happened between another writer's read
 * and its rename would be silently discarded. `appendJsonlLine` uses
 * `fs.appendFile` (O_APPEND) specifically so concurrent appends interleave
 * safely instead of racing a replace. Do not "consolidate" this into
 * atomic-write.ts — the two solve different problems.
 */

import { appendFile, open } from "node:fs/promises";
import { isNotFound } from "./errors.ts";

export type AppendJsonlResult = {
  /** True when a newline-less predecessor was detected and healed before this append. */
  healed: boolean;
};

/**
 * Appends one record as a single JSONL line to `filePath`, healing a
 * newline-less predecessor left by a prior writer.
 *
 * 1. Serializes `record`. A serialized line containing a raw `\n` is
 *    rejected — a JSONL record is single-line by definition — so a
 *    malformed record can never itself corrupt the file.
 * 2. Reads the file's current last byte (if the file exists and is
 *    non-empty). When it is not `\n`, the predecessor left the line open;
 *    this call prefixes its own payload with a healing `\n` so the two
 *    records land on separate lines instead of merging.
 * 3. Appends via `fs.appendFile` (O_APPEND) — never replaces the file.
 *
 * A missing file is not a healing case: `ENOENT` on the last-byte read
 * means there is no predecessor to heal, so `healed` is `false` and the
 * file is created fresh by the append.
 */
export async function appendJsonlLine(
  filePath: string,
  record: Record<string, unknown>,
): Promise<AppendJsonlResult> {
  const line = JSON.stringify(record);
  if (line.includes("\n")) {
    throw new Error(
      "appendJsonlLine: serialized record contains a raw newline — a JSONL record must be single-line",
    );
  }

  return appendRawLineHealing(filePath, `${line}\n`);
}

/**
 * Lower-level healing engine shared by `appendJsonlLine` and any caller that
 * already holds a fully-formatted, newline-terminated line string rather
 * than a raw record object — e.g. `reconcile-learnings.ts`'s `ReconcileFsSeam.appendFile`,
 * whose signature is string-based and must stay that way for its existing
 * fake-seam test coverage. Exported so that caller can route its real
 * (non-test) implementation through the same healing logic without a
 * lossy JSON.stringify → JSON.parse round trip. Not for general use —
 * `appendJsonlLine` is the sanctioned entry point for anything holding a
 * plain record object.
 */
export async function appendRawLineHealing(
  filePath: string,
  rawLine: string,
): Promise<AppendJsonlResult> {
  const healed = await predecessorLeftLineOpen(filePath);
  const prefix = healed ? "\n" : "";
  await appendFile(filePath, `${prefix}${rawLine}`, "utf-8");
  return { healed };
}

/**
 * True when `filePath` exists, is non-empty, and its final byte is not
 * `\n` (0x0a) — i.e. the predecessor writer left the last line open. False
 * for a missing file (`ENOENT` — nothing to heal) or an empty file.
 */
async function predecessorLeftLineOpen(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}
