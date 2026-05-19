/**
 * progressive-disclosure.ts — Progressive disclosure utility for large MCP responses.
 *
 * If a serialized payload is under the threshold, returns it unchanged.
 * If over threshold, writes the full payload to a workspace file and returns
 * a compact summary with a file pointer so callers can access the full data.
 *
 * Pure-ish function: no external dependencies, single side effect is the file write.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default threshold: 12,000 characters (~3,000 tokens). */
export const DEFAULT_DISCLOSURE_THRESHOLD = 12_000;

export type DisclosureResult<T> =
  | { truncated: false; data: T }
  | { truncated: true; summary: string; full_data_path: string; byte_size: number };

export type DisclosureOptions<T> = {
  /** Character count threshold. Responses at or under this pass through unchanged. */
  threshold?: number;
  /** Absolute path to the directory where the full data file will be written. */
  outputDir: string;
  /** Prefix for the output filename (e.g., "file-context", "get-context"). */
  filePrefix: string;
  /** Function that produces a compact summary of the data for the truncated result. */
  summarize: (data: T) => string;
};

/**
 * Apply progressive disclosure to a response payload.
 *
 * If the serialized data is at or under the threshold, returns `{ truncated: false, data }`.
 * If over threshold, writes the full JSON to `{outputDir}/{filePrefix}-{hash}.json` and
 * returns `{ truncated: true, summary, full_data_path, byte_size }`.
 *
 * Error handling: file write errors propagate to the caller. MCP tools are wrapped in
 * `wrapHandler` which converts unexpected throws to UNEXPECTED CanonToolError.
 */
export const applyDisclosure = <T>(data: T, opts: DisclosureOptions<T>): DisclosureResult<T> => {
  const serialized = JSON.stringify(data);
  const threshold = opts.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;

  if (serialized.length <= threshold) {
    return { data, truncated: false };
  }

  const hash = createHash("md5").update(serialized).digest("hex").slice(0, 8);
  const fileName = `${opts.filePrefix}-${hash}.json`;
  const filePath = join(opts.outputDir, fileName);

  mkdirSync(opts.outputDir, { recursive: true });
  writeFileSync(filePath, serialized, "utf-8");

  return {
    byte_size: Buffer.byteLength(serialized, "utf-8"),
    full_data_path: filePath,
    summary: opts.summarize(data),
    truncated: true,
  };
};
