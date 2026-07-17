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
 *
 * **Marker [2] is heading-anchored (W-1 fix, 2026-07-17):** it exists solely
 * to catch the reviewer stub's HEADING form (`## Canon Review — Verdict:
 * IN_PROGRESS`) — the frontmatter form is already independently caught by
 * marker [1]. It was originally unanchored + case-insensitive with no `^`,
 * so it matched the substring "Verdict: IN_PROGRESS" ANYWHERE in the first
 * 8192 chars, including inside a FINALIZED review body that merely quotes
 * the marker string in prose (e.g. a review of Canon's own skeleton
 * machinery). That false positive defeated `emitWriteReceipt` and the WR-02
 * disk fallback for a legitimate class of finished reviews. Requiring the
 * match to start a heading line (`^#{1,6}`, `m` flag) preserves detection of
 * the real stub while no longer matching mid-prose quotation.
 */
export const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /^#{1,6}\s.*Verdict:\s*IN_PROGRESS\b/im,
  /^status:\s*["']?IN_PROGRESS["']?\b/im,
];

/**
 * True when `content`'s head matches any `PARTIAL_MARKERS` skeleton marker —
 * i.e. this is a step-1 skeleton, not a finished deliverable. Only the first
 * 8192 chars are checked (markers live in frontmatter / the first heading);
 * shared by the write-receipt gate's WR-02 disk fallback (`hasRealCanonicalFile`)
 * and the finalized-only receipt guard (`emitWriteReceipt`) so both consume the
 * identical definition of "skeleton".
 */
export function isSkeletonContent(content: string): boolean {
  const head = content.slice(0, 8192);
  return PARTIAL_MARKERS.some((re) => re.test(head));
}
