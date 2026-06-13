/**
 * decisions-ledger — deterministic orchestrator decisions ledger.
 *
 * Two MCP tools (command-query-separation):
 *   - logDecision (command): appends a timestamped, typed decision record
 *     to the execution-store event log under event type "orchestrator_decision".
 *     This is an AUTHORITATIVE write — a store failure is surfaced as a ToolResult
 *     error so the orchestrator knows the decision was NOT logged. (This is the
 *     deliberate inversion of fail-open cliff-telemetry — a lost decision is the
 *     exact failure this build exists to prevent.)
 *   - getDecisions (query): reads all orchestrator_decision events from the store;
 *     returns the structured array + a human-readable rendered markdown table.
 *
 * ADR-0010 settles the substrate choice: execution-store event log (appendEvent /
 * getEventsByType), NOT cliff-ledger (wrong shape) and NOT a new table.
 *
 * See DESIGN.md Workstream A and ledger-01-PLAN.md for rationale.
 */

import { isAbsolute } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { EventOutput } from "@domains/workspaces/execution-store-types.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** The closed enum of orchestrator decision points. */
export type DecisionType =
  | "hitl_gate"
  | "scope_cut"
  | "ac_change"
  | "tier_override"
  | "merge_resolution"
  | "manual_verification"
  | "other";

/**
 * Input for the log_decision command.
 *
 * @param workspace - Absolute path to the Canon workspace directory.
 * @param decision_type - Closed enum identifying the decision category.
 * @param summary - One-line human-readable "what was decided".
 * @param rationale - Optional explanation of why.
 * @param outcome - Optional result string (e.g. "approved", "overridden", "descoped").
 * @param gate - Optional HITL gate name (e.g. "plan_approval", "review_verdict").
 * @param refs - Optional references (e.g. ["AC#3", "REVIEW.md"]).
 * @param projectDir - Injected by resolveScope(extra); unused by store but kept for signature parity.
 */
export type LogDecisionInput = {
  workspace: string;
  decision_type: DecisionType;
  summary: string;
  rationale?: string;
  outcome?: string;
  gate?: string;
  refs?: string[];
  projectDir?: string;
};

/** Return value for the log_decision command (minimal ack per CQS). */
export type LogDecisionResult = {
  decision_type: DecisionType;
  logged: true;
};

/**
 * A structured decision record returned by getDecisions.
 *
 * @param id - Auto-assigned integer from the execution store.
 * @param timestamp - ISO-8601 string from the event payload (store-stamped).
 * @param decision_type - The decision category.
 * @param summary - One-line "what was decided".
 * @param rationale - Optional reason.
 * @param outcome - Optional result.
 * @param gate - Optional gate name.
 * @param refs - Optional reference list.
 */
export type DecisionRecord = {
  id: number;
  timestamp: string;
  decision_type: string;
  summary: string;
  rationale?: string;
  outcome?: string;
  gate?: string;
  refs?: string[];
};

/**
 * Input for the get_decisions query.
 *
 * @param workspace - Absolute path to the Canon workspace directory.
 * @param projectDir - Injected by resolveScope(extra).
 */
export type GetDecisionsInput = {
  workspace: string;
  projectDir?: string;
};

/** Return value for the get_decisions query. */
export type GetDecisionsResult = {
  decisions: DecisionRecord[];
  rendered: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read a string field from an arbitrary payload object safely. */
function readStr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Read a string[] field from an arbitrary payload object safely. */
function readStrArr(payload: Record<string, unknown>, key: string): string[] | undefined {
  const v = payload[key];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

/** Escape backslashes and pipe characters in a markdown table cell value. */
function escapePipe(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Truncate a string to at most `max` chars, appending "..." if truncated. */
function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/**
 * Map a raw execution-store EventOutput to a typed DecisionRecord.
 * Uses typeof guards on payload fields — no unknown escape hatch.
 */
function eventToDecisionRecord(event: EventOutput): DecisionRecord {
  const payload = (
    typeof event.payload === "object" && event.payload !== null ? event.payload : {}
  ) as Record<string, unknown>;

  const record: DecisionRecord = {
    decision_type: readStr(payload, "decision_type") ?? "other",
    id: event.id,
    summary: readStr(payload, "summary") ?? "",
    timestamp: readStr(payload, "timestamp") ?? event.timestamp ?? new Date().toISOString(),
  };

  const rationale = readStr(payload, "rationale");
  if (rationale !== undefined) record.rationale = rationale;

  const outcome = readStr(payload, "outcome");
  if (outcome !== undefined) record.outcome = outcome;

  const gate = readStr(payload, "gate");
  if (gate !== undefined) record.gate = gate;

  const refs = readStrArr(payload, "refs");
  if (refs !== undefined) record.refs = refs;

  return record;
}

/**
 * Render a list of DecisionRecord objects as a markdown table.
 *
 * Returns a human-readable table with columns: # | Time | Type | Summary | Outcome | Rationale.
 * Empty input returns a placeholder line.
 *
 * This is a PURE function (deep-modules: render separated from I/O).
 */
export function renderDecisionsTable(records: DecisionRecord[]): string {
  if (records.length === 0) {
    return "_No decisions logged yet._";
  }

  const header = "| # | Time | Type | Summary | Outcome | Rationale |";
  const sep = "|---|------|------|---------|---------|-----------|";

  const rows = records.map((r) => {
    const time = r.timestamp ? r.timestamp.replace("T", " ").slice(0, 16) : "-";
    const summary = escapePipe(truncate(r.summary, 60));
    const outcome = escapePipe(r.outcome ?? "-");
    const rationale = r.rationale ? escapePipe(truncate(r.rationale, 80)) : "-";
    return `| ${r.id} | ${time} | ${r.decision_type} | ${summary} | ${outcome} | ${rationale} |`;
  });

  return [header, sep, ...rows].join("\n");
}

// ── Command: logDecision ──────────────────────────────────────────────────────

/**
 * Append a timestamped, typed decision record to the execution-store event log.
 *
 * This is an AUTHORITATIVE write: a store failure returns a ToolResult error
 * (WORKSPACE_NOT_FOUND or UNEXPECTED) — it does NOT silently swallow failures.
 * The orchestrator MUST see a failed decision write.
 *
 * @param input - Decision details including workspace, type, and summary.
 * @returns Minimal ack `{ logged: true, decision_type }` on success.
 * @returns ToolResult error on validation failure or store failure.
 */
export async function logDecision(input: LogDecisionInput): Promise<ToolResult<LogDecisionResult>> {
  const { decision_type, gate, outcome, rationale, refs, summary, workspace } = input;

  // Validate workspace is an absolute, non-empty path (mirrors post-event.ts)
  if (!workspace || !isAbsolute(workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be a non-empty absolute path; got: "${workspace}"`,
    );
  }

  // Validate summary is a non-empty string
  if (!summary?.trim()) {
    return toolError("INVALID_INPUT", "summary must be a non-empty string");
  }

  // Open the execution store — fail with WORKSPACE_NOT_FOUND on error
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }

  // Build payload, omitting undefined fields (mirrors post-event.ts)
  const payload: Record<string, unknown> = {
    decision_type,
    summary,
    timestamp: new Date().toISOString(),
  };
  if (rationale !== undefined) payload.rationale = rationale;
  if (outcome !== undefined) payload.outcome = outcome;
  if (gate !== undefined) payload.gate = gate;
  if (refs !== undefined && refs.length > 0) payload.refs = refs;

  // AUTHORITATIVE write — do NOT wrap in fail-open catch.
  // If appendEvent throws, wrapHandler will surface UNEXPECTED to the orchestrator.
  // The orchestrator MUST know that a decision was NOT logged.
  // (Contrast: cliff-telemetry is deliberately fail-open; do NOT copy that posture here.)
  store.appendEvent("orchestrator_decision", payload);

  return toolOk({ decision_type, logged: true as const });
}

// ── Query: getDecisions ───────────────────────────────────────────────────────

/**
 * Read all orchestrator decisions from the execution-store event log.
 *
 * Returns the structured array of DecisionRecord objects AND a rendered
 * human-readable markdown table. This is the QUERY half of CQS — no mutation.
 *
 * @param input - Workspace path to read from.
 * @returns `{ decisions, rendered }` on success.
 * @returns ToolResult error on validation failure or store failure.
 */
export async function getDecisions(
  input: GetDecisionsInput,
): Promise<ToolResult<GetDecisionsResult>> {
  const { workspace } = input;

  // Validate workspace is absolute
  if (!workspace || !isAbsolute(workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be a non-empty absolute path; got: "${workspace}"`,
    );
  }

  // Open execution store
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }

  const events = store.getEventsByType("orchestrator_decision");
  const decisions = events.map(eventToDecisionRecord);
  const rendered = renderDecisionsTable(decisions);

  return toolOk({ decisions, rendered });
}
