---
id: doc-trim-fact-preservation
title: Doc-Trim Builds Require a Reviewer Fact-Preservation Audit
severity: convention
scope:
  tags:
    - reviewer
    - doc-trim
    - scribe
    - context-sync
  file_patterns:
    - "CLAUDE.md"
    - "**/CLAUDE.md"
tags:
  - reviewer
  - doc-trim
  - documentation
  - scribe
---

When a doc-trim build deletes or relocates protocol or contract content from a `CLAUDE.md` file, the reviewer's Stage 2 (structural pass) MUST include a fact-preservation audit. The audit verifies that every deleted fact arrived at a declared destination — not merely that a pointer to a destination was written.

**Trigger condition**: Any doc-trim that reduces a single `CLAUDE.md` file by more than 20% of its byte count, regardless of whether relocation pointers were written.

## Audit Protocol

1. For each section, heading, or contract paragraph deleted from the source file, grep for a representative token (function name, constant, field name, or first sentence of the section) across all declared destination files.
2. Build a relocation table:

   | Deleted fact | Destination file | Found? |
   |---|---|---|
   | `{fact}` | `{path}` | yes / no |

   Every row must have `Found: yes` in a file that actually contains the content — a pointer entry in the source file is not sufficient.

3. **Pointer-without-destination (BLOCKING)**: If a pointer exists in the source file but the destination file does not contain the relocated content, flag as:
   `Pointer-without-destination: {source} → {destination} — content not found`

4. **Silent loss (BLOCKING)**: If content was deleted with no pointer and cannot be found in any file, flag as:
   `Silent loss: {fact} not found in any file`

## Rationale

Two production instances confirmed the pattern: a doc-trim that writes pointers but skips populating destinations produces a partially-consistent doc set. The reviewer's fact-preservation audit is the mitigation that worked — it surfaces "pointer-before-destination" silently-lost contract clusters before the build ships.

### Instance 1 (PR #317 — scope violation)

During `learner-cleanup`, the scribe applied a ~4,500-character compression pass to `CLAUDE.md`, deleting 97 lines of behavioral protocol (the refine tier table, reconciliation-on-resume steps, adversarial re-review procedure, team-dispatch partition logic, re-spawn enrichment protocol, DAG parallel-execution callout) that were outside the build's authorized scope. Detection required post-scribe diff inspection by the orchestrator; fix was a full `git revert`.

### Instance 2 (PR #329 — pointer-before-destination)

During `trim-mcp-server-claudemd`, round 1 trimmed 42,620 → 22,633 bytes and wrote relocation pointers in the top-level file, but 5 of 7 targeted destination directories were empty. The reviewer's fact-preservation audit found 7 silently-lost contract clusters (boot.sh launcher detail, `RecurringViolation.weighted_instance_count`, craft audit service contracts, PR review data service contracts, `DriftStore.getReviews` AND-filter, `DRIFT_SCHEMA_VERSION="9"` table, 4 accuracy drifts). Two fix iterations and one merge round were required.

## Examples

**Good — relocation table with all rows verified:**

```
Fact-Preservation Audit:

| Deleted fact | Destination file | Found? |
|---|---|---|
| `resolveScope` contract | `mcp-server/src/features/orchestration/.claude/CLAUDE.md` | yes — line 42 |
| `RecurringViolation.weighted_instance_count` | `mcp-server/src/features/diagnostics/.claude/CLAUDE.md` | yes — line 18 |
| `DRIFT_SCHEMA_VERSION="9"` table | `mcp-server/src/features/diagnostics/.claude/CLAUDE.md` | yes — line 31 |
```

No BLOCKING findings — all relocated content confirmed in destination files.

**Bad — pointer written but destination empty:**

```
Fact-Preservation Audit:

| Deleted fact | Destination file | Found? |
|---|---|---|
| `boot.sh` launcher detail | `mcp-server/src/app/.claude/CLAUDE.md` | no — file is empty |
| craft audit service contracts | `mcp-server/src/features/diagnostics/.claude/CLAUDE.md` | no — not found |
```

BLOCKING: Pointer-without-destination: `mcp-server/.claude/CLAUDE.md` → `mcp-server/src/app/.claude/CLAUDE.md` — content not found.
BLOCKING: Silent loss: craft audit service contracts (`selectAuditAreas`, `persistAuditProfile`) not found in any file.

## Exceptions

- Doc-trim builds that only delete genuinely stale content (references to deleted files, archived build slugs, or obsolete tool names) with no relocation are exempt from the table requirement, but the reviewer must grep for each deleted token to confirm it is not referenced elsewhere before marking the deletion as a verified stale removal.
- Reordering or restructuring passes that do not change byte count by more than 20% are exempt.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Pointers are enough — anyone reading knows where to look." | A pointer is a promise. An empty destination means the content is lost. The reviewer's job is to verify the promise was kept, not to trust it. | Grep the destination file for the relocated content before marking it found. |
| "The scribe authored the relocation — it was verified during authoring." | Authoring and verification are different acts. The scribe that wrote the pointer may not have written the destination in the same pass (confirmed by Instance 2). | The reviewer is the independent fact-checker. Run the audit. |
| "This is a doc-only change — it cannot break anything." | Lost protocol facts cause agent behavior regressions (Instance 1 deleted adversarial re-review procedure; Instance 2 lost DriftStore contract). Behavioral regression from missing docs is real. | Run the fact-preservation audit. It costs one grep per deleted section. |

## Verification

- [ ] A relocation table is present in the review for every `CLAUDE.md` doc-trim exceeding 20% byte reduction.
- [ ] Every row in the relocation table has a `Found: yes` entry citing the destination file and a line reference.
- [ ] No "pointer written, destination empty" state exists at review time.
- [ ] Silent losses (deletions with no pointer and no destination) are flagged as BLOCKING.
