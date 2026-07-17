# learning/ — Learning-Resolution Flow

## Purpose
Closes the learning-resolution leak (ADR-0050): proposals under
`.canon/proposed-learnings/{timestamp}/` orphan in "pending" state when their
learning ships out-of-band (batch-promotion PRs, direct writer
`apply-proposal`, manual edits). `/canon:review-learnings` previously computed
"pending" purely from the absence of an `applied/`/`rejected/`/`dismissed/`
subdir, so already-shipped learnings masqueraded as a live backlog
indefinitely.

Also owns `append_learning_record` (ADR-0058), the sanctioned agent-facing
seam for appending to `.canon/learning.jsonl` — closes a separate corruption
mode where agents executing freeform Bash against prose instructions
improvised shell append idioms with no newline-termination guarantee, merging
two records onto one unparseable line.

## Architecture

| File | Responsibility |
|------|----------------|
| `actionability.ts` | Shared classifier: `classifyProposal({ filename, frontmatter })` -> `{ actionability, reason }`. Pure, no I/O. Single source of truth for `ACTIONABLE_TYPES`/`INFORMATIONAL_TYPES` — consumed by both this tool and the `/canon:review-learnings` command. |
| `reconcile-learnings.ts` | `reconcile_learnings` MCP tool handler + service. Scans the TIMESTAMPED-DIR surface only (never the loose top-level `.md` files, PROBE-FINDINGS P4). |
| `reconcile-learnings-seams.ts` | `ReconcileFsSeam`/`ReconcileGitSeam` types, `DirEntry`/`CommitEvidence` types, `defaultFsSeam`/`defaultGitSeam` implementations — extracted out of `reconcile-learnings.ts` (which sits at the `noExcessiveLinesPerFile` budget) and re-exported unchanged from there. `ReconcileFsSeam` carries a `realpath` member so production wiring is symlink-safe while in-memory test fakes supply an identity resolver. |
| `append-learning-record.ts` | `append_learning_record` MCP tool handler + service (ADR-0058). Serializes and newline-terminates a caller-supplied `record` object via `appendJsonlLine` (`@shared/lib/jsonl-append.ts`) — no target-path parameter, no byte-level control left in the caller's hands. |
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
  `principles/**/<id>.md` / `.canon/principles/**/<id>.md`) — re-contained
  under `project_dir` via `isPathContained` (a resolved path escaping via
  `..` segments is treated as unresolved, closing a path-traversal existence
  oracle) — exists on disk AND `git log --since=<proposal date> -- <target>`
  shows a commit — the evidence predicate (decision 0047; guards against
  false-positive auto-resolve). A commit that CREATED the target is
  sufficient on its own; a DEDICATED creation probe (`creationCommitSince`,
  `--diff-filter=A`) checks for this FIRST and recovers an OLDER creating
  commit even when a NEWER, unrelated commit later churns the same file —
  the plain most-recent-commit view (`latestCommitSince`) alone would only
  ever see the newer churn commit and (wrongly) conclude the target was
  never created, orphaning the proposal forever. Only when no creation
  commit is found does evaluation fall back to `latestCommitSince`: a commit
  that only MODIFIED an already-existing target must additionally reference
  the proposal (its id, or the target's principle id) in the commit message
  — an unrelated churn commit to the same (often frequently-edited) file is
  not evidence. The proposal-date bound uses the frontmatter `created` field
  when it is a recognized full timestamp, falling back to the
  full-precision dir-timestamp when `created` is date-only (a date-only
  value collapses to an implicit midnight and can falsely count a
  same-day-earlier commit as post-dating an evening proposal) OR malformed
  (a value that is neither date-only nor a full timestamp, e.g. `soon`, is
  never handed to `git log --since` verbatim — git's approxidate parser
  would silently mis-parse it). INFORMATIONAL proposals are never
  reconciled — they have no apply-mapping.
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
  at the end of the apply loop — this bounds a mid-apply crash's
  unlogged-move window to AT MOST the single proposal in flight when the
  crash lands (down from the whole batch under end-of-loop batching); the
  residual one-proposal window (a crash between that proposal's own rename
  and its append) is inherent to non-atomic filesystem operations and is not
  eliminated (`explicit-transaction-boundaries`). `ReconcileFsSeam.appendFile`
  (the real, non-test implementation) is newline-safe (ADR-0058): it routes
  through `appendRawLineHealing` (`@shared/lib/jsonl-append.ts`), the same
  healing engine `appendJsonlLine` uses, so a predecessor writer that left the
  file's last line open (missing `\n`) is healed before this append lands
  instead of merging onto it.
- **Idempotent**: reconciled/archived files no longer appear as top-level
  `.md` files in their `{ts}/` dir on the next run, so a second run over
  already-resolved state is a zero-mutation no-op by construction — no
  special-casing needed.
- **`dry_run: true`**: returns the computed plan with zero filesystem
  mutations (used by tests and by the command to preview).
- **`validate-at-trust-boundaries`** (ADR-0058 amendments): three checks, in
  order, before any filesystem walk. (1) `project_dir` validated via
  `isSafeProjectDirInput` (rejects path-escape/non-absolute input — an
  allow-list barrier, not containment on its own). (2) `project_dir` is
  contained against the caller's resolved session scope (`resolveScope(extra)`
  threaded in from `register-learning.ts`) via `isPathContained` (the pure,
  non-symlink-resolving check — this file's test suite drives fully in-memory
  fake `project_dir` strings that never exist on disk, so its fakes supply an
  identity `realpath` resolver rather than forcing the real, slower symlink
  check here). (3) the `project_dir/.canon` ancestor of every write target is
  re-contained via `isPathContainedResolvingAncestor` — closes a round-3
  finding where a genuine, in-scope `project_dir` whose own `.canon` was a
  symlink escaped one level down. `freshness_days` validated as a positive
  finite number. **Documented, accepted residual (ADR-0058 "Amendment:
  fix-review round 4")**: this handler's true write/rename targets —
  `.canon/proposed-learnings/{ts}/...` and the `applied/`/`stale/` rename
  destinations beneath it — are NOT re-contained past the `.canon` ancestor
  check; a symlink at or below `proposed-learnings` is not caught. Accepted
  because both grantee agents (`learner`, `writer`) already hold `Bash`, so
  the residual grants no capability beyond an existing grant.

**`appendLearningRecord(input, defaultProjectDir)`** (`append-learning-record.ts`,
ADR-0058) — `{ project_dir, record: Record<string, unknown> }` ->
`ToolResult<{ appended: true, path, healed: boolean }>`. The sanctioned
agent-facing append seam for `.canon/learning.jsonl` — the tool serializes and
newline-terminates `record` via `appendJsonlLine` (`@shared/lib/jsonl-append.ts`);
the caller hands over an object and never touches bytes. No target-path
parameter by design (`agent-never-trust-overlay-tier`) — writes to a fixed
`project_dir/.canon/learning.jsonl`.

- **`validate-at-trust-boundaries`**: three checks before any filesystem
  access, mirroring `reconcileLearnings` above but with the symlink-safe
  variants (this file's tests use real `mkdtemp` dirs, so the stronger checks
  apply at no cost): (1) `isSafeProjectDirInput` allow-list barrier; (2)
  `project_dir` contained against `defaultProjectDir` via `isPathInWorktree`
  (symlink-aware, real `fs.realpath`); (3) the write target
  (`project_dir/.canon/learning.jsonl`) re-contained via
  `isPathContainedResolvingAncestor` — tolerates the target or `.canon` not
  existing yet (this function `mkdir`s `.canon/` on a legitimate first run)
  while still rejecting a `.canon` that resolves out of scope via symlink, or
  a *pre-existing* `learning.jsonl` symlink resolving to an already-existing
  out-of-scope file.
- **`healed: true`** in the result means this call detected a newline-less
  predecessor and repaired it before appending — an observability signal that
  something bypassed the tool (or an earlier corruption is being healed).
- **Documented, accepted residual (ADR-0058 "Amendment: fix-review round
  4")**: a *dangling* symlink at `.canon/learning.jsonl` (the symlink object
  exists; its target does not exist yet) bypasses the ancestor-walk check —
  `isPathContainedResolvingAncestor` cannot distinguish "nothing here" (the
  legitimate first-run case) from "a symlink exists here but its target
  hasn't been created yet." Accepted for the same Bash-parity reason as
  `reconcileLearnings`'s residual above; see `docs/adr/0058-*.md` Follow-up
  for the deferred root-cause fix (an `lstat` on the leaf before the
  ancestor-walk fallback).
- **I/O failures are `UNEXPECTED`/`recoverable: true`**, not `INVALID_INPUT`:
  matches the sibling `reconcileLearnings` catch-all — an ENOSPC/EACCES/EIO/
  EMFILE during `appendJsonlLine`'s own I/O is not the caller's fault and
  should not be reported as a malformed record.

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
- Any code that writes `.canon/learning.jsonl` must go through
  `appendJsonlLine`/`appendRawLineHealing` (`@shared/lib/jsonl-append.ts`) —
  never a raw `fs.appendFile`/shell `>>` — and agent-facing instructions must
  name `append_learning_record` as the only sanctioned append path (ADR-0058).
