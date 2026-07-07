/**
 * mandatory-artifact-map — the fail-closed write-receipt completion gate's
 * agent_type -> required-artifact allowlist (RCA Option C, see
 * docs/adr/0042-fail-closed-write-receipt-completion-gate.md).
 *
 * This is the single source of truth for which `agent_type` values must
 * produce a receipt-backed artifact before `log_step`/`batch_log_steps` will
 * accept a `status:"completed"` for one of their steps. Absence from this map
 * is a structural (not discretionary) zero-artifact exemption — see
 * `isExemptStep` in `exempt-step-patterns.ts` for the other exemption path
 * (fix-mode steps for a mapped agent_type).
 *
 * shipper / learner / evaluator / pm are intentionally ABSENT — they produce
 * no mandatory artifact and must never be added here.
 */

export type WriteReceiptKind =
  | "implementation_summary"
  | "review"
  | "test_report"
  | "design"
  | "context_sync"
  | "security_assessment"
  | "plan_index";

export type MandatoryArtifact = {
  /** Receipt kinds that satisfy this agent_type's requirement (strong path). */
  kinds: readonly WriteReceiptKind[];
  /** WR-02 fallback ONLY — a non-skeleton file at one of these globs also passes. */
  canonical_paths: readonly string[];
};

export const MANDATORY_ARTIFACT_MAP: Record<string, MandatoryArtifact> = {
  architect: { canonical_paths: ["plans/*/DESIGN.md"], kinds: ["design"] },
  engineer: { canonical_paths: ["plans/*/*-SUMMARY.md"], kinds: ["implementation_summary"] },
  reviewer: { canonical_paths: ["reviews/REVIEW.md"], kinds: ["review"] },
  scribe: { canonical_paths: ["plans/*/CONTEXT-SYNC.md"], kinds: ["context_sync"] },
  security: { canonical_paths: ["plans/*/SECURITY.md"], kinds: ["security_assessment"] },
  tester: { canonical_paths: ["plans/*/TEST-REPORT.md"], kinds: ["test_report"] },
};
