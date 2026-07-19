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
 *
 * **Scan scoped to the leading region, not the whole head (W-2/W-3 fix,
 * round 2, 2026-07-19):** line-anchoring alone (W-1) is insufficient —
 * `^` matches the start of EVERY line in the scanned 8192-char head,
 * including a line inside a fenced code block deep in a finalized body
 * (a review quoting Canon's own skeleton machinery in a ```yaml fence), or
 * a later markdown heading that merely quotes the stub string (e.g. a
 * heading titled `### Marker [2]: ... Verdict: IN_PROGRESS` while
 * discussing this very bug). Both false-positive classes defeat
 * `emitWriteReceipt`/WR-02 exactly like W-1 did. Skeleton markers only ever
 * legitimately appear in an artifact's leading diagnostic region — the YAML
 * frontmatter block and/or its opening heading(s) — never in fenced code or
 * body prose. `isSkeletonContent` now extracts that leading region
 * (`extractLeadingRegion`) and scans only it: the frontmatter block (if
 * present) plus every contiguous heading/blank line that follows,
 * stopping at the first substantive (non-blank, non-heading) body line —
 * a fence opener or a prose paragraph both count as substantive and end
 * the region before any marker text inside them is ever scanned.
 */
export const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /^#{1,6}\s.*Verdict:\s*IN_PROGRESS\b/im,
  /^status:\s*["']?IN_PROGRESS["']?\b/im,
];

/** Matches a complete leading `---\n...\n---` YAML frontmatter fence, if present. */
const FRONTMATTER_FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Matches a markdown ATX heading line (`#` through `######`, followed by whitespace). */
const HEADING_LINE = /^#{1,6}\s/;

/**
 * Extracts the artifact's leading diagnostic region: the YAML frontmatter
 * block (if present) plus every contiguous heading/blank line that follows
 * it, stopping at the first substantive (non-blank, non-heading) line —
 * a fenced-code opener or a prose paragraph. Skeleton markers only ever
 * legitimately appear here (see the class doc comment above).
 */
function extractLeadingRegion(content: string): string {
  const head = content.slice(0, 8192);
  const frontmatterMatch = FRONTMATTER_FENCE.exec(head);
  let region = "";
  let rest = head;
  if (frontmatterMatch) {
    region += frontmatterMatch[0];
    rest = head.slice(frontmatterMatch[0].length);
  }
  for (const line of rest.split(/\r?\n/)) {
    if (line.trim() === "") {
      region += "\n";
      continue;
    }
    if (HEADING_LINE.test(line)) {
      region += `${line}\n`;
      continue;
    }
    break;
  }
  return region;
}

/**
 * True when `content`'s leading diagnostic region matches any
 * `PARTIAL_MARKERS` skeleton marker — i.e. this is a step-1 skeleton, not a
 * finished deliverable. Only the leading region is checked (frontmatter +
 * leading heading lines — see `extractLeadingRegion`), never fenced code or
 * body prose; shared by the write-receipt gate's WR-02 disk fallback
 * (`hasRealCanonicalFile`) and the finalized-only receipt guard
 * (`emitWriteReceipt`) so both consume the identical definition of
 * "skeleton".
 */
export function isSkeletonContent(content: string): boolean {
  const region = extractLeadingRegion(content);
  return PARTIAL_MARKERS.some((re) => re.test(region));
}
