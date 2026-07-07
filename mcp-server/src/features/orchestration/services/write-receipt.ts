/**
 * write-receipt — the durable proof mechanism + fail-closed completion gate
 * for the write-receipt completion gate (RCA Option C).
 *
 * `emitWriteReceipt` is called by each of the six mandatory-artifact write
 * tools (3 existing: write_implementation_summary / write_review /
 * write_test_report; 3 new: write_design / write_context_sync /
 * write_security_assessment) immediately after the artifact file is
 * successfully written. `enforceWriteReceipt` is the fail-closed gate called
 * from `orchestration-journal.ts` (`logStep` + `processEntries`) immediately
 * after `enforceArtifacts`.
 *
 * See docs/adr/0042-fail-closed-write-receipt-completion-gate.md.
 */

import { globSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { EventOutput } from "@domains/workspaces/execution-store-types.ts";
import { type ToolResult, toolError } from "@shared/lib/tool-result.ts";
import type { JournalStep } from "../tools/orchestration-journal.ts";
import { isExemptStep } from "./exempt-step-patterns.ts";
import {
  MANDATORY_ARTIFACT_MAP,
  type MandatoryArtifact,
  type WriteReceiptKind,
} from "./mandatory-artifact-map.ts";
import { PARTIAL_MARKERS } from "./partial-markers.ts";

/**
 * Normalize a workspace path so the emit side and the gate-query side always
 * resolve to the same execution store. An agent-supplied `workspace` may
 * accidentally be the worktree path (`{workspace}/worktree`) rather than the
 * workspace root (ASSUMPTION 4 / False-Close row a). Strips exactly one
 * trailing `worktree` path segment.
 */
export function normalizeWorkspaceRoot(workspace: string): string {
  const resolved = resolve(workspace);
  return basename(resolved) === "worktree" ? dirname(resolved) : resolved;
}

export type WriteReceiptPayload = {
  artifact_kind: WriteReceiptKind;
  artifact_path: string;
  slug?: string;
  task_id?: string;
};

/**
 * Emit a durable `write_receipt` event proving a mandatory artifact's
 * canonical write tool ran. Fail-open: a store error is caught and warned,
 * never thrown — a lost receipt must never break the artifact write that
 * just succeeded (it degrades to the gate's WR-02 disk-check fallback).
 */
export function emitWriteReceipt(workspace: string, payload: WriteReceiptPayload): void {
  try {
    const store = getExecutionStore(normalizeWorkspaceRoot(workspace));
    store.appendEvent("write_receipt", { ...payload, written_at: new Date().toISOString() });
  } catch (err) {
    console.warn(
      "[write-receipt] emitWriteReceipt failed (fail-open — artifact write already succeeded):",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Resolve an artifact glob to concrete files under both workspace roots (mirrors reconcile-workspace.ts). */
function resolveCanonicalFiles(workspace: string, artifact: string): string[] {
  const files: string[] = [];
  for (const root of [workspace, join(workspace, "worktree")]) {
    for (const match of globSync(artifact, { cwd: root })) {
      files.push(join(root, match));
    }
  }
  return files;
}

/**
 * WR-02: true when at least one file resolved from `canonicalPaths` exists
 * and is NOT a skeleton (per the shared `PARTIAL_MARKERS` regex list —
 * single source of truth, reused from reconcile-workspace.ts). Synchronous
 * by design — `enforceWriteReceipt` is a synchronous drop-in at the
 * `enforceArtifacts` call sites.
 */
function hasRealCanonicalFile(workspace: string, canonicalPaths: readonly string[]): boolean {
  for (const pattern of canonicalPaths) {
    for (const file of resolveCanonicalFiles(workspace, pattern)) {
      try {
        const content = readFileSync(file, "utf-8");
        const head = content.slice(0, 8192); // markers live in frontmatter / first heading
        if (!PARTIAL_MARKERS.some((re) => re.test(head))) return true;
      } catch {
        // unreadable — not classifiable as a real file here; try the next candidate
      }
    }
  }
  return false;
}

/**
 * Fetch every `write_receipt` event and filter to those stamped at/after
 * `since` (inclusive) — `getEvents({ since })` is exclusive (`timestamp >
 * since`) at the store layer, but the join key here is deliberately inclusive
 * (a receipt stamped in the same instant as `started_at` must still count as
 * strong-path proof; ISO-8601 strings compare correctly lexicographically).
 * `since` disambiguates re-spawn/replay (WR-01). Returns `null` on the gate's
 * OWN infra failure (fail-open — a corrupt store must not wedge a build).
 */
function queryReceiptsSince(workspace: string, since: string | undefined): EventOutput[] | null {
  try {
    const store = getExecutionStore(normalizeWorkspaceRoot(workspace));
    const allReceipts = store.getEvents({ type: "write_receipt" });
    return since ? allReceipts.filter((event) => event.timestamp >= since) : allReceipts;
  } catch (err) {
    console.warn(
      "[write-receipt] enforceWriteReceipt: getEvents failed — failing open:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Fail-open telemetry marking a WR-02 file-branch pass (see Forge-Gap Residual Risk in DESIGN.md). */
function emitWeakPassTelemetry(
  workspace: string,
  step: JournalStep,
  required: MandatoryArtifact,
): void {
  try {
    const store = getExecutionStore(normalizeWorkspaceRoot(workspace));
    store.appendEvent("write_receipt_weak_pass", {
      agent_type: step.agent_type,
      artifact_kinds: required.kinds,
      step_id: step.step_id,
    });
  } catch (err) {
    console.warn(
      "[write-receipt] write_receipt_weak_pass telemetry emit failed (fail-open):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The fail-closed write-receipt completion gate — enforce-always, no mode
 * param. Mirrors `enforceArtifacts`'s call-site contract: `null` means pass,
 * a `ToolResult` error means reject.
 *
 * Algorithm (see DESIGN.md "The fail-closed gate"):
 *   1. `agent_type` not in the map -> pass (shipper/learner/evaluator/pm/unknown).
 *   2. `isExemptStep(step_id)` -> pass (fix-mode / recovery).
 *   3. A durable `write_receipt` of a required kind since `started_at` -> pass (strong path).
 *   4. WR-02: no receipt, but a real (non-skeleton) canonical file exists -> pass
 *      + fail-open `write_receipt_weak_pass` telemetry.
 *   5. Else -> reject, mirroring `enforceArtifacts`'s rejection shape.
 *
 * Fail-open on the gate's OWN infra failure (`getEvents` throws) — a corrupt
 * store must not wedge a build. This is the deliberate opposite of failing
 * closed on the checked condition itself.
 */
export function enforceWriteReceipt(workspace: string, step: JournalStep): ToolResult<null> | null {
  const required = step.agent_type ? MANDATORY_ARTIFACT_MAP[step.agent_type] : undefined;
  if (!required) return null;
  if (isExemptStep(step.step_id)) return null;

  const receipts = queryReceiptsSince(workspace, step.started_at);
  if (receipts === null) return null; // gate infra failure — fail open

  const hasStrongReceipt = receipts.some((event) => {
    const kind = event.payload.artifact_kind;
    return typeof kind === "string" && (required.kinds as readonly string[]).includes(kind);
  });
  if (hasStrongReceipt) return null;

  if (hasRealCanonicalFile(workspace, required.canonical_paths)) {
    emitWeakPassTelemetry(workspace, step, required);
    return null;
  }

  return toolError(
    "INVALID_INPUT",
    `Cannot complete step '${step.step_id}': no write receipt and no artifact on disk for required artifact(s): ${required.kinds.join(", ")} (agent_type=${step.agent_type})`,
    true,
    { receipt_missing: [...required.kinds] },
  );
}
