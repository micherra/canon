/**
 * Cliff de-dupe ledger (loops-phase-c-03)
 *
 * Per-session surface-once ledger for cliff detection. Prevents session-watch
 * from re-surfacing the same mid-flight cliff every tick and colliding with
 * resume/post_subagent passes.
 *
 * The ledger is stored at ${workspace}/.cliff-surfaced.json — a JSON array
 * of signature strings. It is cleaned up at finalize time (workspace-cleanup.ts).
 *
 * Design decisions honoured:
 * - loops-phase-c-03: per-session surface-once ledger, NOT the drift.db cliff_events table
 * - errors-as-values / fail-open: every ledger read/write is fail-open; never throws
 * - command-query-separation: filterUnsurfaced (query) kept separate from appendLedger (command)
 * - simplicity-first: small JSON file mirroring the loop state-file pattern; no DB schema
 *
 * Principle alignment:
 * - errors-as-values: ENOENT → empty; parse error → empty; write error → warn + return
 * - command-query-separation: read path and write path are separate exported functions
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Ledger file relative to workspace root. */
const LEDGER_FILENAME = ".cliff-surfaced.json";

/** Step type the ledger operates on (minimal subset needed for signature). */
export type LedgerStep = {
  step_id: string;
  missing_artifacts: string[];
  partial_artifacts: string[];
};

/**
 * Compute a stable, order-insensitive signature for a cliff step.
 *
 * A changed cliff (new missing artifact) yields a new signature;
 * an unchanged one repeats its prior signature.
 *
 * Format: `${step_id}|${sorted missing}|${sorted partial}`
 */
export function cliffSignature(step: LedgerStep): string {
  const missing = [...step.missing_artifacts].sort().join(",");
  const partial = [...step.partial_artifacts].sort().join(",");
  return `${step.step_id}|${missing}|${partial}`;
}

/**
 * Read the existing ledger for a workspace.
 *
 * Returns an empty set on ENOENT or any parse error (fail-open).
 * Never throws.
 */
export async function readLedger(workspace: string): Promise<Set<string>> {
  const ledgerPath = join(workspace, LEDGER_FILENAME);
  try {
    const raw = await readFile(ledgerPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    // ENOENT or JSON parse error → empty set (fail-open)
    return new Set<string>();
  }
}

/**
 * Append signatures to the ledger (union with existing).
 *
 * Uses temp-file + rename for atomic write under concurrency.
 * Fail-open: a write error warns and returns without throwing.
 */
export async function appendLedger(workspace: string, signatures: string[]): Promise<void> {
  if (signatures.length === 0) return;
  const ledgerPath = join(workspace, LEDGER_FILENAME);
  const tmpPath = `${ledgerPath}.tmp`;
  try {
    const existing = await readLedger(workspace);
    for (const sig of signatures) existing.add(sig);
    const payload = JSON.stringify([...existing], null, 2);
    await writeFile(tmpPath, payload, "utf-8");
    await rename(tmpPath, ledgerPath);
  } catch (err) {
    console.warn(
      "[canon] cliff-ledger: failed to write ledger:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Filter steps to those not yet surfaced, returning them plus their signatures.
 *
 * Reads the current ledger, returns steps whose signature is NOT already present,
 * plus the full set of new signatures to append after surfacing.
 *
 * Caller flow (CQS): read → surface toSurface → appendLedger(signatures), in that order.
 * Do NOT call appendLedger before surfacing — it would mark them as surfaced before display.
 */
export async function filterUnsurfaced(
  workspace: string,
  steps: LedgerStep[],
): Promise<{ toSurface: LedgerStep[]; signatures: string[] }> {
  const ledger = await readLedger(workspace);
  const toSurface: LedgerStep[] = [];
  const signatures: string[] = [];
  for (const step of steps) {
    const sig = cliffSignature(step);
    if (!ledger.has(sig)) {
      toSurface.push(step);
      signatures.push(sig);
    }
  }
  return { signatures, toSurface };
}
