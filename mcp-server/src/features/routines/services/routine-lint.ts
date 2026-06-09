import type { Routine } from "@shared/routine.ts";
import { resolveBinding } from "./resolve-binding.ts";

/**
 * A lint finding produced by `lintRoutines`.
 *
 * Callers (commands, writer review, CI) decide severity — this service only
 * returns the findings (errors-are-values).
 */
export type RoutineLintFinding = {
  /** The `name` of the offending routine. */
  routine: string;
  /** Machine-readable finding code. */
  code: string;
  /** Human-readable explanation. */
  message: string;
};

// Allowed values for `guardrails.repo_writes` (guardrail floor).
const ALLOWED_REPO_WRITES = new Set<string>(["notify-only", "draft-pr", "none"]);

/**
 * Lint a list of routine artifacts and return all findings.
 *
 * Scope: routine artifacts ONLY.  This function does NOT inspect principle
 * files, `/loop` files, or running-build configuration.
 *
 * Pure function — no I/O, no side effects (simplicity-first).
 * Returns findings; never throws (errors-are-values).
 */
export function lintRoutines(routines: Routine[]): RoutineLintFinding[] {
  return routines.flatMap((routine) => lintOne(routine));
}

// ---------------------------------------------------------------------------
// Internal — single-routine lint
// ---------------------------------------------------------------------------

function lintOne(routine: Routine): RoutineLintFinding[] {
  const findings: RoutineLintFinding[] = [];
  const { name, guardrails, recurrence, needs, binding_target } = routine;

  // 1. Adaptive-queen invariant (PRD AC#12): mutates_running_build must be
  //    exactly `false`.  Anything else (true, missing/defaulted to non-false)
  //    fires a finding.
  if (guardrails.mutates_running_build !== false) {
    findings.push({
      code: "MUTATES_RUNNING_BUILD",
      message:
        `Routine "${name}" has guardrails.mutates_running_build !== false. ` +
        "The adaptive-queen invariant requires this field to be exactly false.",
      routine: name,
    });
  }

  // 2. Guardrail-floor ceiling (PRD AC#9): repo_writes must be within the
  //    allowed set {notify-only, draft-pr, none}.
  if (!ALLOWED_REPO_WRITES.has(guardrails.repo_writes)) {
    findings.push({
      code: "REPO_WRITES_CEILING",
      message:
        `Routine "${name}" has repo_writes "${guardrails.repo_writes}", which exceeds the ` +
        "guardrail ceiling. Allowed values: notify-only, draft-pr, none.",
      routine: name,
    });
  }

  // 3. Consent default (PRD AC#9 / #5): durable repo-writers (standing +
  //    draft-pr) MUST have consent:opt-in.  tier-gated is insufficient for
  //    standing routines that can open draft PRs.
  if (
    recurrence === "standing" &&
    guardrails.repo_writes === "draft-pr" &&
    guardrails.consent !== "opt-in"
  ) {
    findings.push({
      code: "CONSENT_DEFAULT",
      message:
        `Routine "${name}" is a standing draft-pr routine but consent is ` +
        `"${guardrails.consent}". Durable repo-writers require consent:opt-in.`,
      routine: name,
    });
  }

  // 4. Binding override contradiction (PRD AC#7 hard-fail): an explicit
  //    binding_target that contradicts resolveBinding(needs) is an error.
  if (binding_target !== undefined) {
    const resolved = resolveBinding(needs);
    if (binding_target !== resolved) {
      findings.push({
        code: "BINDING_OVERRIDE_CONTRADICTION",
        message:
          `Routine "${name}" has binding_target:"${binding_target}" but ` +
          `resolveBinding(needs) resolves to "${resolved}". ` +
          "The explicit override contradicts the needs-derived binding.",
        routine: name,
      });
    }
  }

  return findings;
}
