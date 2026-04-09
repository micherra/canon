/**
 * learn-gate — Gate evaluation for auto-triggered learning (ADR-016).
 *
 * Evaluates all 5 learn gates in cheapest-first order:
 *   1. Config check (enabled flag)
 *   2. Time gate (hours since last learn)
 *   3. Scan throttle (prevent repeated flow-count queries)
 *   4. Flow gate (enough flows since last learn)
 *   5. Lock gate (acquire the learn lock)
 *
 * Returns { passed: true } only if ALL gates pass.
 * Best-effort: unexpected errors return { passed: false, reason } — gate evaluation
 * must never block flow completion.
 *
 * Canon principles:
 *   - toolresult-contract: returns structured LearnGateResult, never throws for expected failures
 *   - no-silent-failures: all gate failures have a human-readable reason
 *   - define-errors-out-of-existence: learn_gate_passed is optional; callers unaffected if absent
 */

import { readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadLearnGateConfig } from "@shared/lib/config.ts";
import { acquireLearnLock, getLastLearnTimestamp } from "@shared/lib/learn-lock.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";

export type LearnGateResult = {
  passed: boolean;
  /** Human-readable reason for gate failure (absent when passed: true). */
  reason?: string;
};

/**
 * Allowed write path prefix for canon-learner output (Advisory 1 / ADR-016).
 * Must match the write_scope declared in the canon-learner tool profile.
 */
const LEARNER_WRITE_PREFIX = ".canon/proposed-learnings/";

/**
 * Post-hoc validation: verify that all files in the proposed-learnings directory
 * are within the allowed write scope for canon-learner.
 *
 * This is a defense-in-depth check — the agent prompt constrains write paths,
 * and this function validates the output after the learner completes.
 *
 * @param projectDir - Project root directory
 * @returns { valid: boolean; violations: string[] }
 */
export async function validateLearnerOutput(
  projectDir: string,
): Promise<{ valid: boolean; violations: string[] }> {
  const allowedDir = join(projectDir, LEARNER_WRITE_PREFIX);
  const violations: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(allowedDir, { recursive: true, encoding: "utf-8" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Directory doesn't exist — no output to validate, which is valid
      return { valid: true, violations: [] };
    }
    throw err;
  }

  for (const entry of entries) {
    const fullPath = join(allowedDir, entry);
    // Compute path relative to project root and verify prefix
    const relPath = relative(projectDir, fullPath);
    if (!relPath.startsWith(LEARNER_WRITE_PREFIX)) {
      violations.push(fullPath);
    }
  }

  return { valid: violations.length === 0, violations };
}

/** 10-minute scan throttle — prevents repeated flow-count DB queries. */
const SCAN_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Evaluate all learn gates in cheapest-first order.
 * Returns { passed: true } only if ALL gates pass.
 * Returns { passed: false, reason } for any gate failure or unexpected error.
 */
export async function evaluateLearnGate(projectDir: string): Promise<LearnGateResult> {
  // Gate 1: Config check (cheapest — cached per-tick)
  const config = await loadLearnGateConfig(projectDir);
  if (!config.enabled) return { passed: false, reason: "auto-learn disabled" };

  const canonDir = join(projectDir, ".canon");

  // Gate 2: Time gate — hours since last learn
  const lastLearnTs = await getLastLearnTimestamp(canonDir);
  if (lastLearnTs !== null) {
    const hoursSinceLast = (Date.now() - lastLearnTs) / (1000 * 60 * 60);
    if (hoursSinceLast < config.min_hours_since_last) {
      return {
        passed: false,
        reason: `time gate: ${hoursSinceLast.toFixed(1)}h < ${config.min_hours_since_last}h`,
      };
    }
  }

  // Gate 3: Scan throttle — prevent repeated flow-count queries
  const throttlePath = join(canonDir, "learn-throttle");
  try {
    const throttleStat = await stat(throttlePath);
    const msSinceThrottle = Date.now() - throttleStat.mtime.getTime();
    if (msSinceThrottle < SCAN_THROTTLE_MS) {
      return { passed: false, reason: "scan throttle: checked recently" };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Non-ENOENT stat error (e.g. permissions) — fail closed rather than block flow completion.
      return { passed: false, reason: `scan throttle: stat error` };
    }
    // No throttle file = never throttled, continue
  }

  // Gate 4: Flow gate — enough flows since last learn
  const driftDb = getDriftDb(projectDir);
  const sinceIso =
    lastLearnTs !== null ? new Date(lastLearnTs).toISOString() : "1970-01-01T00:00:00.000Z";
  const flowCount = driftDb.countFlowRunsSince(sinceIso);
  if (flowCount < config.min_flows_since_last) {
    // Touch throttle marker so we don't re-query for 10 minutes
    try {
      await writeFile(throttlePath, "", { flag: "w", mode: 0o600 });
    } catch {
      /* best effort */
    }
    return {
      passed: false,
      reason: `flow gate: ${flowCount} < ${config.min_flows_since_last}`,
    };
  }

  // Gate 5: Lock gate — acquire the learn lock
  const staleAfterMs = config.lock_stale_after_hours * 60 * 60 * 1000;
  const lockResult = await acquireLearnLock(canonDir, staleAfterMs);
  if (!lockResult.acquired) {
    return { passed: false, reason: `lock gate: ${lockResult.reason}` };
  }

  return { passed: true };
}
