/**
 * Environment detection utilities for background job control.
 *
 * These functions are pure boolean predicates — they never throw.
 * They read environment variables only; no side effects.
 */

/** Returns true when Canon should run jobs synchronously (inline). */
export function isSyncMode(): boolean {
  const explicit = process.env.CANON_SYNC_JOBS;
  if (explicit !== undefined) {
    return explicit === "1" || explicit.toLowerCase() === "true";
  }
  return isCI();
}

/** Returns true when running in a CI environment. */
export function isCI(): boolean {
  return process.env.CI !== undefined;
}
