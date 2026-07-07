/**
 * partial-markers — the shared skeleton-marker regex list.
 *
 * Single source of truth for "this artifact is still a step-1 skeleton, not
 * a finished deliverable" (per `rules/agent-artifact-write-before-return.md`).
 * Lifted out of `reconcile-workspace.ts` so both cliff-detection
 * (`reconcile-workspace.ts`) and the write-receipt completion gate's WR-02
 * fallback (`write-receipt.ts`) consume the identical list without a
 * `services/ -> tools/ -> services/` import cycle.
 *
 * - `## Status: Partial` — architect, security skeletons
 * - `IN_PROGRESS` verdict — reviewer Early Output Protocol stub (frontmatter
 *   `verdict: IN_PROGRESS` and `## Canon Review — Verdict: IN_PROGRESS`)
 * - `IN_PROGRESS` status — scribe skeleton (frontmatter `status: "IN_PROGRESS"`,
 *   the context-sync template's own status field, per `templates/context-sync.md`)
 */
export const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /Verdict:\s*IN_PROGRESS\b/i,
  /^status:\s*["']?IN_PROGRESS["']?\b/im,
];
