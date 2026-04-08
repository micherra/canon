/**
 * Git Intelligence Configuration
 *
 * Default configuration for hotspot scoring and co-change detection,
 * plus the isExcluded utility for filtering files by glob patterns.
 */

import { basename } from "node:path";

export type GitIntelConfig = {
  lookbackDays: number;
  halfLifeDays: number;
  jaccardThreshold: number;
  hotspotScoreThreshold: number; // score threshold (0–1); files above this are marked is_hotspot=1
  excludePatterns: string[];
};

export const DEFAULT_GIT_INTEL_CONFIG: GitIntelConfig = {
  lookbackDays: 90,
  halfLifeDays: 45,
  jaccardThreshold: 0.3,
  hotspotScoreThreshold: 0.75,
  excludePatterns: [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.config.js",
    "*.config.ts",
    "*.config.mjs",
    ".eslintrc*",
    ".prettierrc*",
    "tsconfig*.json",
  ],
};

/**
 * Check if a file path matches any exclusion pattern.
 * Matches against the **basename** only (not full path) so that
 * patterns like `*.config.js` match `src/app/webpack.config.js`.
 * Supports simple glob with `*` wildcard (matches any characters).
 */
export const isExcluded = (filePath: string, patterns: string[]): boolean => {
  const name = basename(filePath);
  return patterns.some((pattern) => {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  });
};
