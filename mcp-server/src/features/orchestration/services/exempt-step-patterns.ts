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
 * `^security-early-scan` covers the security agent's early-scan/inline-only
 * mode (see `agents/security.md` "Mode Detection") — it produces a brief
 * inline advisory, not a SECURITY.md artifact, so it is inherently
 * zero-artifact. Early-scan runs during the design conversation today, not
 * as a journaled runbook step, so this is currently inert — but IF a
 * security step is ever journaled under `role: early-scan`, it MUST use this
 * reserved step_id prefix or the write-receipt gate will false-close it. The
 * real full-scan security-assessment step uses a plain `security`/
 * `security-assessment` step_id and is NOT covered by this pattern — the
 * receipt guarantee (ADR-0042) stays intact for it.
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
  /^security-early-scan/,
];

export function isExemptStep(stepId: string): boolean {
  return EXEMPT_STEP_PATTERNS.some((pattern) => pattern.test(stepId));
}
