# learning/ — Learning-Resolution Flow

## Purpose
Closes the learning-resolution leak (ADR-0047): proposals under
`.canon/proposed-learnings/{timestamp}/` orphan in "pending" state when their
learning ships out-of-band (batch-promotion PRs, direct writer
`apply-proposal`, manual edits). `/canon:review-learnings` previously computed
"pending" purely from the absence of an `applied/`/`rejected/`/`dismissed/`
subdir, so already-shipped learnings masqueraded as a live backlog
indefinitely.

## Architecture

| File | Responsibility |
|------|----------------|
| `actionability.ts` | Shared classifier: `classifyProposal({ filename, frontmatter })` -> `{ actionability, reason }`. Pure, no I/O. Single source of truth for `ACTIONABLE_TYPES`/`INFORMATIONAL_TYPES` — consumed by both this tool and the `/canon:review-learnings` command. |
| `reconcile-learnings.ts` | `reconcile_learnings` MCP tool handler + service. Scans the TIMESTAMPED-DIR surface only (never the loose top-level `.md` files, PROBE-FINDINGS P4). |
| `index.ts` | Barrel export — the one import path for `app/register-learning.ts` and future consumers. |

## Contracts

**`classifyProposal(input)`** — decision order: (1) declared `type` in
`ACTIONABLE_TYPES` -> actionable; (2) declared `type` in
`INFORMATIONAL_TYPES` -> informational; (3) no recognized type -> filename
prefix fallback (`sug_`/`convention_` -> actionable, `watch_`/`note_` ->
informational); (4) no signal at all -> informational (conservative default —
an unclassified item is never Accept/Reject-prompted). Reads both frontmatter
formats: YAML `type: X` (checked first) and legacy bold `**Type**: X`
(fallback).

**`reconcileLearnings(input, seams?)`** (`reconcile-learnings.ts`) —
`{ project_dir, freshness_days?, dry_run? }` -> `ToolResult<ReconcileLearningsOutput>`
(`reconciled[]`, `archived[]`, `flagged_stale[]`, `skipped[]`). Injectable
`{ fs: ReconcileFsSeam, git: ReconcileGitSeam }` seam parameter (defaults to
`defaultFsSeam`/`defaultGitSeam`, real `node:fs/promises` + `gitExec`) —
tests supply fakes directly rather than mocking modules.

- **Reconcile**: only ACTIONABLE pending proposals are eligible. A proposal
  reconciles only when its resolved target path (`target_path` ->
  `target_file` -> `target`-as-principle-id, first existing of
  `principles/**/<id>.md` / `.canon/principles/**/<id>.md`) exists on disk AND
  `git log --since=<proposal date> -- <target>` shows a commit — the
  evidence predicate (decision 0047; guards against false-positive
  auto-resolve). A commit that CREATED the target is sufficient on its own;
  a commit that only MODIFIED an already-existing target must additionally
  reference the proposal (its id, or the target's principle id) in the
  commit message — an unrelated churn commit to the same (often
  frequently-edited) file is not evidence. The proposal-date bound uses the
  frontmatter `created` field when it carries a time component, falling back
  to the full-precision dir-timestamp when `created` is date-only (a
  date-only value collapses to an implicit midnight and can falsely count a
  same-day-earlier commit as post-dating an evening proposal). INFORMATIONAL
  proposals are never reconciled — they have no apply-mapping.
- **Freshness** (decision `freshness-policy`): `FRESHNESS_DAYS = 30` default,
  overridable via `freshness_days`. A stale set (`age > freshness_days`) that
  is fully informational (zero actionable survivors after reconcile)
  auto-archives every remaining pending file to `{ts}/stale/`. A stale set
  with an actionable survivor is flagged only (`flagged_stale[]`) — never
  auto-archived, preserving HITL for real work.
- **Pending = per-file, not per-dir**: a `.md` file directly at the top level
  of a `{ts}/` dir. This is the fix for the prior bug — the command used to
  treat an entire timestamped dir as "pending" purely from *subdir absence*;
  reconcile checks each file's own resolution state.
- **Fail-open** (`fail-closed-by-default` vs `observable-best-effort`
  tension, documented inline): this is an advisory quality mechanism, not a
  safety gate. Plan-building (all reads) is fully separated from plan-applying
  (all mutations) — any thrown error during planning aborts before any
  mutation happens, so a fail-open abort never leaves a partial move. A
  `console.warn` is always emitted on the fail-open branch.
- **Append-only / move-never-delete**: `learning.jsonl` is only ever appended
  to (new `"accepted"`/`"archived"` lines); a proposal file is only ever
  `rename`d into a resolution subdir, never `rm`'d. The append happens
  immediately after each proposal's own rename (`moveAndAppend`), not batched
  at the end of the apply loop — so a crash partway through applying a plan
  never leaves an already-moved file with no audit line
  (`explicit-transaction-boundaries`).
- **Idempotent**: reconciled/archived files no longer appear as top-level
  `.md` files in their `{ts}/` dir on the next run, so a second run over
  already-resolved state is a zero-mutation no-op by construction — no
  special-casing needed.
- **`dry_run: true`**: returns the computed plan with zero filesystem
  mutations (used by tests and by the command to preview).
- **`validate-at-trust-boundaries`**: `project_dir` validated via
  `isSafeProjectDirInput` (rejects path-escape/non-absolute input);
  `freshness_days` validated as a positive finite number — both checked
  before any filesystem walk.

## Invariants
- Scope is the TIMESTAMPED-DIR surface (`.canon/proposed-learnings/{ts}/`)
  ONLY — the 471 loose top-level files are governed by the learner's separate
  CONSOLIDATE disposition engine (`decideWatchDisposition`) and must never be
  touched here.
- Must not import internal modules from other features — enforced by
  `mcp-server/.dependency-cruiser.cjs` `no-cross-feature-internal-import`.
- No duplicated actionable/informational type lists elsewhere —
  `actionability.ts` is the single source of truth for both the tool and the
  `/canon:review-learnings` command.
