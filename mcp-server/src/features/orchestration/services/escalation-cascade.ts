/**
 * escalation-cascade — Pure escalation state machine.
 *
 * Implements the auto-escalation cascade for dark-factory agents. When an agent
 * cannot complete a step, the orchestrator calls getNextStrategy to determine
 * the next fallback to try before escalating to a human.
 *
 * Default cascade order: add_primer → increase_budget → escalate_model → narrow_scope → hitl
 *
 * Design decisions:
 *  - getNextStrategy is a pure function: deterministic given (state, config)
 *  - State is immutable: recordAttempt returns a new object, never mutates
 *  - Missing state initializes fresh (define-errors-out-of-existence)
 *  - Hard timeout (2 min default) ensures cascade always terminates at hitl
 *  - Strategies tracked by name (not index) so reordering doesn't break in-flight cascades
 */

import type { ExecutionStore } from "@domains/workspaces/execution-store.ts";

// ---- Types ----

export type EscalationStrategy =
  | "add_primer"
  | "increase_budget"
  | "escalate_model"
  | "narrow_scope"
  | "hitl";

export type EscalationAttempt = {
  strategy: EscalationStrategy;
  attempted_at: string;
  step_id: string;
};

export type EscalationState = {
  attempts: EscalationAttempt[];
  cascade_started_at: string;
  current_step_id: string;
};

export type EscalationConfig = {
  /** Strategies to skip for this flow type. E.g., security skips narrow_scope. */
  skip_strategies?: EscalationStrategy[];
  /** Max cascade duration in ms. Default: 120000 (2 min). */
  timeout_ms?: number;
};

export type EscalationResult = {
  strategy: EscalationStrategy;
  reasoning: string;
  attempts_so_far: number;
  time_elapsed_ms: number;
  /** true when strategy is "hitl" */
  is_terminal: boolean;
};

// ---- Constants ----

const DEFAULT_ORDER: EscalationStrategy[] = [
  "add_primer",
  "increase_budget",
  "escalate_model",
  "narrow_scope",
  "hitl",
];

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

// ---- Pure helpers ----

function buildStrategyReasoning(strategy: EscalationStrategy, state: EscalationState): string {
  const attemptCount = state.attempts.length;
  switch (strategy) {
    case "add_primer":
      return "no prior attempts; injecting domain primer to improve agent context";
    case "increase_budget":
      return `after ${attemptCount} attempt(s); increasing turn budget to allow more exploration`;
    case "escalate_model":
      return `after ${attemptCount} attempt(s); escalating to a more capable model`;
    case "narrow_scope":
      return `after ${attemptCount} attempt(s); narrowing task scope to reduce complexity`;
    case "hitl":
      return "all automated fallback strategies exhausted; human review required";
  }
}

// ---- Core state machine ----

/**
 * Pure function: determines the next escalation strategy to try.
 * Never throws; always returns a valid EscalationResult.
 */
export function getNextStrategy(
  state: EscalationState,
  config?: EscalationConfig,
): EscalationResult {
  const timeoutMs = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const skip = new Set<EscalationStrategy>(config?.skip_strategies ?? []);

  const now = Date.now();
  const elapsed = now - new Date(state.cascade_started_at).getTime();
  const attemptsSoFar = state.attempts.length;

  // Timeout check — always terminates at hitl
  if (elapsed >= timeoutMs) {
    return {
      attempts_so_far: attemptsSoFar,
      is_terminal: true,
      reasoning: "cascade timeout exceeded",
      strategy: "hitl",
      time_elapsed_ms: elapsed,
    };
  }

  const attempted = new Set<EscalationStrategy>(state.attempts.map((a) => a.strategy));

  // Find the next unattempted, non-skipped strategy
  for (const strategy of DEFAULT_ORDER) {
    if (skip.has(strategy)) continue;
    if (attempted.has(strategy)) continue;
    return {
      attempts_so_far: attemptsSoFar,
      is_terminal: strategy === "hitl",
      reasoning: buildStrategyReasoning(strategy, state),
      strategy,
      time_elapsed_ms: elapsed,
    };
  }

  // All strategies exhausted (after skipping and prior attempts)
  return {
    attempts_so_far: attemptsSoFar,
    is_terminal: true,
    reasoning: "all fallback strategies exhausted",
    strategy: "hitl",
    time_elapsed_ms: elapsed,
  };
}

/**
 * Creates a fresh escalation state for the given step.
 */
export function initEscalationState(stepId: string): EscalationState {
  return {
    attempts: [],
    cascade_started_at: new Date().toISOString(),
    current_step_id: stepId,
  };
}

/**
 * Returns a new EscalationState with the attempt appended.
 * Immutable: does not mutate the input state.
 */
export function recordAttempt(
  state: EscalationState,
  strategy: EscalationStrategy,
  stepId: string,
): EscalationState {
  const attempt: EscalationAttempt = {
    attempted_at: new Date().toISOString(),
    step_id: stepId,
    strategy,
  };
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    current_step_id: stepId,
  };
}

// ---- Persistence (execution store metrics) ----

const METRICS_KEY = "escalation_state";

/**
 * Reads escalation state from execution store metrics.
 * Returns null when no state has been persisted for the given stateId.
 */
export function readEscalationState(
  store: ExecutionStore,
  stateId: string,
): EscalationState | null {
  const stateEntry = store.getState(stateId);
  if (!stateEntry) return null;

  const metrics = stateEntry.metrics as Record<string, unknown> | undefined;
  if (!metrics) return null;

  const raw = metrics[METRICS_KEY];
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw) as EscalationState;
  } catch {
    return null;
  }
}

/**
 * Persists escalation state to execution store metrics.
 * Uses the merge pattern (spread existing + new) to avoid overwriting other metrics.
 */
export function writeEscalationState(
  store: ExecutionStore,
  stateId: string,
  state: EscalationState,
): void {
  store.updateStateMetrics(stateId, { [METRICS_KEY]: JSON.stringify(state) });
}
