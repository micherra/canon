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
 * **Two-class scan, not one uniform region (W-A fix, round 3, 2026-07-19):**
 * round 2 (below) scoped ALL four markers to a single "leading region"
 * (frontmatter + contiguous leading headings, stopping at the first
 * substantive line) to close a fenced/body false-positive class (W-2/W-3).
 * That over-corrected: it introduced a fail-**open** regression (W-A) — a
 * genuine architect/security skeleton commonly writes one line of prose
 * under its title before the `## Status: Partial` footer (`# Design\n\nThis
 * document is being drafted.\n\n## Status: Partial`), and the leading-region
 * scan stops at that prose line, never reaching the marker. A missed
 * skeleton is the dangerous direction: it lets a died-mid-write artifact
 * pass both `emitWriteReceipt` and the WR-02 disk fallback as "finalized,"
 * defeating the exact write-cliff detection this module exists for.
 *
 * The markers split into two classes with different legitimate ranges:
 *
 * - **HEADING markers** (`## Status: Partial` — marker [0]) are section
 *   headings. A real skeleton's authoring agent may write body content
 *   (even other section headings) before appending its status footer —
 *   nothing pins the marker to the very first line. So marker [0] is
 *   scanned across the **whole** (fence-stripped) head, not just the
 *   leading region — this is the load-bearing fix for W-A.
 * - **FRONTMATTER markers** (`verdict: IN_PROGRESS` [1], `status:
 *   "IN_PROGRESS"` [3]) can only ever be produced by the artifact's own
 *   real YAML frontmatter, which is always byte-0-anchored. Scanning body
 *   content for these can only ever find a false positive (a finished doc
 *   quoting the frontmatter shape in prose or a fence), never a genuine
 *   skeleton — so they stay scoped to the leading region.
 * - **Marker [2]** (`## Canon Review — Verdict: IN_PROGRESS`, the reviewer
 *   stub's heading form) is technically a HEADING marker too, but stays
 *   leading-region-scoped rather than joining marker [0]'s whole-head scan:
 *   the reviewer's Early Output Protocol always writes marker [1]
 *   (frontmatter `verdict: IN_PROGRESS`) in the same step-1 write as the
 *   heading, so [1] fully backstops genuine reviewer-stub detection —
 *   there is no scenario where a real reviewer stub carries [2] without
 *   [1] also present in the leading region. Keeping [2] narrow avoids
 *   reopening the W-3 body-heading-quote false positive (a later heading
 *   that merely quotes the stub string, e.g. discussing this very bug)
 *   for no detection benefit.
 *
 * **Fenced code blocks are stripped before either scan (closes W-2):**
 * `stripFencedBlocks` removes fenced (``` or ~~~) code-block spans from the
 * scanned head first, so a review that illustrates a skeleton's marker
 * strings inside a fence — the idiomatic way to document them — never
 * trips any marker, including the whole-head-scanned marker [0]. Without
 * this, moving marker [0] to a whole-head scan would reopen exactly the
 * fenced-example false positive W-2 reported against the sibling markers.
 *
 * **Known accepted residual (documented, not fixed here):** an early
 * body heading — one that is itself part of the leading region, i.e.
 * appears immediately after frontmatter before any substantive line — that
 * merely quotes marker [2]'s string (e.g. `### Marker [2]: ... Verdict:
 * IN_PROGRESS`) can still false-positive, because it is textually
 * indistinguishable from a real stub heading within that scope. This is
 * narrow (real reviews open with the canonical `## Canon Review — Verdict:
 * {verdict}` heading per `templates/review.md`) and asymmetric-risk
 * favors this rare false-positive nuisance over reopening any fail-open
 * gap — never widen marker [2] or [1]/[3] to a whole-head scan to close it.
 *
 * **A second known accepted residual, of the same shape, applies to marker
 * [0]:** because it is scanned across the whole fence-stripped head, a
 * finished document with a real UNFENCED `## Status: Partial` heading
 * false-positives as a skeleton. This is likewise accepted (rare; the
 * idiomatic way to document the marker string is inside a fence, which is
 * already stripped) — see the round-3 fix note above for the fail-open this
 * trades against.
 *
 * **Frontmatter anchor tolerates a leading BOM/blank-line/space prefix
 * (Finding A fix, round 4, 2026-07-20):** `FRONTMATTER_FENCE` is byte-0
 * anchored (`^`, no `m` flag) by design — the FRONTMATTER-class markers can
 * only ever be produced by the artifact's own real YAML frontmatter, which
 * is always byte-0-anchored in a well-formed document. But "byte 0 of the
 * artifact's real content" and "byte 0 of the `content` string a write tool
 * receives" are not the same thing: `write_context_sync` and raw `Write`
 * calls persist `input.content` verbatim, with no guarantee the caller's
 * string starts with `---` at index 0 — a leading BOM (U+FEFF), a leading
 * blank line, or leading spaces on the fence line itself are all
 * unremarkable ways a real skeleton's frontmatter can arrive slightly
 * offset. Requiring exact byte-0 previously missed the fence entirely in
 * those cases — a fail-**open** (the dangerous direction) on a genuine
 * scribe/reviewer skeleton. `extractLeadingRegion` now runs
 * `stripLeadingBomAndBlankLines` on the head before testing
 * `FRONTMATTER_FENCE`, so the anchor tolerates that noise without weakening
 * it: only whitespace/BOM is consumed, so a document that never had
 * frontmatter is scored identically to before.
 */
export const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /^#{1,6}\s.*Verdict:\s*IN_PROGRESS\b/im,
  /^status:\s*["']?IN_PROGRESS["']?\b/im,
];

/** HEADING-class markers: scanned across the whole fence-stripped head (W-A fix — a real skeleton may place its status footer after body content). */
const HEADING_SCAN_MARKERS: readonly RegExp[] = [PARTIAL_MARKERS[0]];

/** FRONTMATTER-class markers (plus marker [2], see class doc above): scanned only within the leading region — body/fence content can never legitimately produce these. */
const LEADING_REGION_MARKERS: readonly RegExp[] = [
  PARTIAL_MARKERS[1],
  PARTIAL_MARKERS[2],
  PARTIAL_MARKERS[3],
];

/** Matches a complete leading `---\n...\n---` YAML frontmatter fence, if present. */
const FRONTMATTER_FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Matches a markdown ATX heading line (`#` through `######`, followed by whitespace). */
const HEADING_LINE = /^#{1,6}\s/;

/** Matches a fenced-code-block opener line (``` or ~~~, 3+ chars, optional trailing language tag). */
const FENCE_OPEN_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Removes fenced (``` or ~~~) code-block spans from `text`, line-by-line —
 * a document quoting a skeleton marker string inside a fence (the idiomatic
 * way to illustrate one) must never trip marker detection (closes W-2).
 *
 * Only a CONFIRMED closed fence (a later line of the same fence character,
 * repeated at least as many times, alone on the line) is stripped. An
 * unterminated fence within the scanned head is left untouched — favoring
 * detection over silence is the same asymmetric-risk call this module makes
 * everywhere else (a missed marker is worse than a rare false positive).
 */
function stripFencedBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const keep = new Array<boolean>(lines.length).fill(true);
  let i = 0;
  while (i < lines.length) {
    const openMatch = FENCE_OPEN_LINE.exec(lines[i]);
    if (!openMatch) {
      i += 1;
      continue;
    }
    const fenceChar = openMatch[1][0];
    const fenceLen = openMatch[1].length;
    const closeLine = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`);
    let closeIdx = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closeLine.test(lines[j])) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      // Unterminated within the scanned head — leave as-is (favor detection).
      i += 1;
      continue;
    }
    for (let k = i; k <= closeIdx; k += 1) keep[k] = false;
    i = closeIdx + 1;
  }
  return lines.filter((_, idx) => keep[idx]).join("\n");
}

/**
 * Strips a leading BOM, leading blank lines, and leading spaces/tabs
 * immediately before an opening `---` fence — closes the Finding A fail-open
 * (see class doc comment above): a write tool's `content` string can carry
 * this noise ahead of otherwise-real, byte-0-equivalent frontmatter, which
 * the exact-anchored `FRONTMATTER_FENCE` regex would otherwise silently
 * miss. Only whitespace/BOM is consumed — no non-whitespace content is
 * altered, so a document that never had frontmatter is unaffected.
 */
function stripLeadingBomAndBlankLines(head: string): string {
  const withoutBom = head.startsWith("﻿") ? head.slice(1) : head;
  return withoutBom.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/^[ \t]+(?=---)/, "");
}

/**
 * Extracts the artifact's leading diagnostic region: the YAML frontmatter
 * block (if present) plus every contiguous heading/blank line that follows
 * it, stopping at the first substantive (non-blank, non-heading) line —
 * a fenced-code opener or a prose paragraph. Used only for the
 * FRONTMATTER-class markers (see class doc above) — never for marker [0],
 * which is intentionally scanned across the whole head.
 */
function extractLeadingRegion(content: string): string {
  const head = stripLeadingBomAndBlankLines(content.slice(0, 8192));
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
 * True when `content` matches any `PARTIAL_MARKERS` skeleton marker — i.e.
 * this is a step-1 skeleton, not a finished deliverable. Shared by the
 * write-receipt gate's WR-02 disk fallback (`hasRealCanonicalFile`) and the
 * finalized-only receipt guard (`emitWriteReceipt`) so both consume the
 * identical definition of "skeleton".
 *
 * Two-class scan (see the module doc comment for the full rationale):
 * fenced code blocks are stripped first, then the HEADING-class marker
 * (`## Status: Partial`) is scanned across the whole fence-stripped head,
 * while the FRONTMATTER-class markers (plus marker [2]) are scanned only
 * within the leading region (frontmatter + leading heading lines).
 */
export function isSkeletonContent(content: string): boolean {
  const head = content.slice(0, 8192);
  const fenceStripped = stripFencedBlocks(head);
  const leadingRegion = extractLeadingRegion(fenceStripped);
  return (
    HEADING_SCAN_MARKERS.some((re) => re.test(fenceStripped)) ||
    LEADING_REGION_MARKERS.some((re) => re.test(leadingRegion))
  );
}
