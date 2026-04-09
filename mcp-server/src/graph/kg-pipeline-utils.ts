/**
 * Knowledge Graph Pipeline — Shared Utilities
 *
 * Pure helper functions used by both kg-pipeline.ts and kg-pipeline-phases.ts.
 */

import { createHash } from "node:crypto";
import { inferLayer } from "@shared/matcher.ts";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fileLayer(relPath: string): string {
  return inferLayer(relPath) ?? "unknown";
}

/** Strip .js / .ts extension aliases used in ESM imports before resolution */
export function normaliseSpecifier(spec: string): string {
  // Strip trailing .js in ESM imports so resolveImport can find .ts sources
  if (spec.endsWith(".js")) return spec.slice(0, -3);
  return spec;
}
