# platform/storage/archive/ — Build Archive Layer

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Platform-level build-archive persistence: copies workspace artifacts to `.canon/history/{slug}/`, assembles `run-summary.json` for cross-run analysis, and records manifest entries in drift.db. Relocated from `features/history/services/` (ADR-0003) — features may now depend on this as a platform service without violating bounded-context boundaries.

## Architecture
<!-- last-updated: 2026-06-12 -->

| File | Responsibility |
|------|---------------|
| `archive-types.ts` | Shared types owned by this module: `RunbookStep`, `PlannerContext`, `StepOutcome`, `ReviewViolation`, `ReviewResult`, `ArtifactInventory`, `RunSummary`; `features/history/history-types.ts` re-exports these for backward compat |
| `archive-service.ts` | `archiveWorkspace(input)` — copies artifact dirs + files, generates `run-summary.json`, records `ArchiveManifestEntry` in drift.db; async, never throws (returns `{ archived: false, error }` on any failure) |
| `run-summary-builder.ts` | `buildRunSummary(input)` — assembles a `RunSummary` from workspace files; always returns a valid object (never throws); composes extractors |
| `run-summary-extractors.ts` | `parsePlanningBrief`, `parseReviewFile`, `parseRunbookSteps` — pure text-parsing helpers; no I/O; never throw; return partial/empty data on parse errors |

## Contracts
<!-- last-updated: 2026-06-12 -->

**`archiveWorkspace(input: ArchiveWorkspaceInput)`** → `Promise<ArchiveWorkspaceResult>` — archives workspace to `.canon/history/{slug}/`; fail-open (archive failure must not block workspace pruning); `archived: false` + `error` on any path; `run_summary_generated: false` when summary assembly fails (archive still proceeds).

**`RunSummary`** (`archive-types.ts`) — `version: 1`; `decision_summaries` is always `[]` (retained for backward compat — the `decisions/` workspace dir was removed 2026-05-25); consumers that branch on its presence remain compatible.

**`buildRunSummary`** — never throws; each extraction sub-call is independently wrapped; missing files return `null` / empty arrays.

**`parsePlanningBrief` / `parseReviewFile` / `parseRunbookSteps`** — pure; no I/O; never throw.

## Invariants
<!-- last-updated: 2026-06-12 -->
- Must not import from `@features/*` — platform layer only; imports `@platform/storage/drift/*`, `@domains/*`, `@shared/*`, `node:*`
- `archiveWorkspace` is best-effort: run-summary failure is non-fatal; drift.db manifest write failure is non-fatal; both are warn-logged and do not abort the archive copy
- `run-summary-extractors.ts` is pure — no filesystem or DB I/O; all I/O is in `run-summary-builder.ts` and `archive-service.ts`
