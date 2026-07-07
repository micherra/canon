/**
 * exempt-step-patterns — the enumerated, non-discretionary zero-artifact
 * exemption for the write-receipt completion gate (`write-receipt.ts`).
 *
 * A step whose `step_id` matches one of these patterns produces a status
 * report, not a mandatory artifact (fix-mode engineer runs, eval-fix
 * iterations, inline WARNING resolution, recovery work) — see
 * `agent-template-required` and the Journal Protocol's `inline-fix`
 * precedent (`orchestration-journal.ts` special-cases it at the agent_id
 * gate). Exempt iff the step_id matches; there is no free-text discretion.
 *
 * Mirrored verbatim (one pattern source per line) in `exempt-step-patterns.txt`
 * for grep-parity, the same convention as `hooks/lib/accepted-skip-reasons.txt`.
 * A parity test enforces the two lists stay in sync — update both together.
 */

export const EXEMPT_STEP_PATTERNS: readonly RegExp[] = [
  /^fix-/,
  /^eval-fix-/,
  /^inline-fix$/,
  /^wip-/,
];

export function isExemptStep(stepId: string): boolean {
  return EXEMPT_STEP_PATTERNS.some((pattern) => pattern.test(stepId));
}
