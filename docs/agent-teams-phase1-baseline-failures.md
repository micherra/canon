# Agent-teams Phase 1 — baseline + PLAN scope resolutions

This doc captures two decisions that came out of the PR #119 architect
review of Phase 1 Wave 1:

1. The test-failure manifest against which Gate A's `npm test` criterion
   is read (baseline "no new regressions" vs. green-from-cold).
2. The PLAN-file scope resolutions for phase1-07, whose authoritative
   scope drifted out of sync with DESIGN.md and v2.md §10.1.

Both decisions are load-bearing for phase1-10 cross-artifact validation
and for anyone auditing the Phase 1 Wave 1 commits.

---

## Baseline test-failure manifest

**Branch baseline:** `main` at `33cdec4` (`docs(agent-teams): begin v2.1 architect review (verdict + soundness) (#118)`)

**Run date:** 2026-04-21

**Run command:** `cd mcp-server && npx vitest run`

**Totals:**

- Test suites: 1495 total / 1471 passed / 24 failed
- Tests: 4695 total / 4658 passed / **37 failed**

## Purpose

Per docs/agent-teams-migration-plan-v2.md §10.1, Gate A requires
`npm run build && npm test` to pass. This file captures the set of test
failures that exist on `main` before any Phase 1 work lands, so the
Gate A criterion can be read as **"no new regressions versus this
manifest"** rather than "green from a cold sandbox."

All 37 baseline failures are environmental — git-worktree operations
failing under sandbox constraints, model-download tests failing when
the HuggingFace CDN is blocked, and a couple of preflight assertions
that depend on a writable git HEAD. None of them exercise
`orchestration-journal.ts`, `hooks/canon-agent-teams/`, or
`references/` — the three surfaces introduced by Phase 1
Wave 1.

## Failure catalogue

### mcp-server/src/domains/workspaces/__tests__/wave-lifecycle.test.ts (13 tests)

Root cause: `git worktree add` fails with `fatal: invalid reference: HEAD`
in the sandbox. The test creates a fresh git repo via `git init`, then
tries to create a worktree from HEAD — but there is no HEAD until a
first commit is made, and the test doesn't commit first (or its first
commit is rejected by sandbox git signing). The worktree-domain tests
cannot run without a cooperative git environment.

- `createWaveWorktrees > creates a worktree directory for each task`
- `createWaveWorktrees > returns correct worktree_path and branch for each task`
- `createWaveWorktrees > creates multiple worktrees without overlap`
- `createWaveWorktrees > creates distinct branches for each task`
- `mergeWaveResults — sequential, no conflict > returns ok:true when all branches merge cleanly`
- `mergeWaveResults — sequential, no conflict > returns merged_count equal to number of tasks on success`
- `mergeWaveResults — conflict detection > returns ok:false with conflict_task when branches conflict`
- `mergeWaveResults — conflict detection > does not silently resolve the conflict — git repo is left clean after abort`
- `cleanupWorktrees > removes worktree directories after cleanup`
- `cleanupWorktrees > returns removed count equal to number of tasks cleaned up`
- `cleanupWorktrees > cleans up multiple worktrees`
- `Integration — create, modify, merge, cleanup > full lifecycle with non-conflicting tasks succeeds end-to-end`
- `Integration — create, modify, merge, cleanup > verifies merge order: tasks are merged sequentially in order`

### mcp-server/src/features/knowledge-graph/__tests__/codebase-graph-integration.test.ts (7 tests)

Root cause: `git commit -m "Initial commit"` fails during test
setup. Sandbox git is configured to require a signing key that the
test harness doesn't provide. The integration tests need a working
commit to establish a repo state before the async job pipeline can
exercise anything.

- `Integration: full async lifecycle > submits a job, worker completes, and poll returns complete status`
- `Integration: cache hit > returns cached: true on second submit with the same fingerprint`
- `Integration: dedup running job > returns deduplicated: true when a running job has the same fingerprint`
- `Integration: sync mode > runs pipeline inline when CANON_SYNC_JOBS=1, returning complete immediately`
- `Integration: cancel > cancels an active job and polls as cancelled`
- `Integration: timeout > marks a job timed_out when the watchdog fires before worker completes`
- `Integration: stale cleanup > marks stale running jobs as failed when cleanup is called`

### mcp-server/src/features/knowledge-graph/__tests__/kg-embedding.test.ts (8 tests)

Root cause: `Forbidden access to file:
"https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json"`.
The embedding-model real-integration tests need to download the
`all-MiniLM-L6-v2` model weights. The sandbox blocks outbound HTTPS
to HuggingFace.

- `EmbeddingService — real embeddings > loads the minilm model and embeds a single text`
- `EmbeddingService — real embeddings > embedding vector has 384 dimensions`
- `EmbeddingService — real embeddings > embeds a batch of texts`
- `EmbeddingService — real embeddings > reuses the same model instance across calls`
- `EmbeddingService — real embeddings > embeddings are normalized (L2 norm ≈ 1.0)`
- `EmbeddingService — real embeddings > batch processing respects EMBEDDING_BATCH_SIZE boundary`
- `EmbeddingService — real embeddings > identical texts produce identical embeddings`
- (1 additional embedding test)

### mcp-server/src/features/orchestration/__tests__/contract-checker.test.ts (3 tests)

Root cause: `git commit -m "initial"` fails (same sandbox signing
issue as codebase-graph-integration). `evaluatePostconditions`'s
`file_changed` type compares the working tree against a base commit
SHA; the tests need a real commit history to exercise.

- `evaluatePostconditions — file_changed > passes when file has changed since base commit`
- `evaluatePostconditions — file_changed > fails when file has NOT changed since base commit`
- `evaluatePostconditions — file_changed > fails with descriptive error when no baseCommit provided`

### mcp-server/src/features/orchestration/__tests__/init-workspace-preflight.test.ts (2 tests)

Root cause: `init_workspace` preflight checks depend on a git HEAD
being readable; in the sandbox git the preflight reports issues that
on a cooperative git would pass. `workspace` comes back as `""` with
`candidate_workspace` populated instead.

- `init_workspace — preflight checks > returns no issues on clean state with preflight: true`
- `init_workspace — preflight checks > workspace contains path and candidate_workspace is undefined when preflight passes`

### mcp-server/src/features/orchestration/__tests__/init-workspace-worktree.test.ts (4 tests)

Root cause: same `git worktree add` sandbox blocker as
`wave-lifecycle.test.ts`. The tests expect `result.worktree_path` to
be defined after `initWorkspaceFlow` creates a worktree; the worktree
call fails silently (by design — Canon falls back when worktree
creation fails) and the path comes back undefined.

- `initWorkspaceFlow — worktree creation on new workspace > returns worktree_path pointing inside .canon/worktrees/{slug}`
- `initWorkspaceFlow — worktree creation on new workspace > returns worktree_branch matching canon/{slug}`
- `initWorkspaceFlow — worktree creation on new workspace > actually creates the worktree directory on disk`
- `initWorkspaceFlow — resume with existing worktree > returns worktree_path when worktree still exists`

## Phase 1 Wave 1 regression-check protocol

Before Gate A can clear, phase1-10 (cross-artifact validation) must run
`npm test` against the Phase 1 head and confirm:

1. **The failing set is exactly this 37-test catalogue, no more and no
   fewer.** Any new name means a regression caused by Phase 1 work.
   Any name dropping out of the set means this manifest needs to be
   regenerated (environment conditions may have changed).

2. **All new tests added by Phase 1 must pass** — at time of writing:
   - `mcp-server/src/features/orchestration/tools/__tests__/orchestration-journal.test.ts` (≥17 cases)
   - `hooks/canon-agent-teams/post-commit-trailers.test.sh`
   - `hooks/canon-agent-teams/completion-verify.test.sh`

3. **All existing passing tests must still pass.**

To regenerate this manifest (if test infrastructure changes
materially), check out `main` clean and run:

```bash
cd mcp-server && npx vitest run --reporter=json > /tmp/results.json
# Then parse failures out of /tmp/results.json.
```

## Follow-up

A Canon issue should be filed to track addressing the environment-
dependent test failures in a more isolated fashion (e.g., by
injecting a mock git-adapter into worktree tests, or by gating
HuggingFace-dependent tests behind a `VITEST_SKIP_NETWORK` flag).
That work is out of scope for Phase 1 Wave 1 and is not a Gate A
blocker once this manifest is accepted.

---

## PLAN scope resolutions

### phase1-07 — 2 vs. 5 hook scripts

**Context.** The phase1-07 PLAN file (`.canon/workspaces/agent-teams-v2/
plans/phase1/phase1-07-PLAN.md`) originally specified 2 hook scripts.
`INDEX.md`, `DESIGN.md` (dc-05), and `docs/agent-teams-migration-plan-v2.md`
§10.1 (lines 1027–1031) all specified **5 hook scripts** as Phase 1
Wave 1 scope. The two documents disagreed; the PLAN file was stale
relative to DESIGN + v2.md.

**Resolution.** The 5-hook scope is authoritative. Phase1-07 ships:

| Script | Trigger | Purpose |
|--------|---------|---------|
| `post-commit-trailers.sh` | PostToolUse (Bash) | Warn when a git commit lands without a `Canon-Workflow` trailer. |
| `completion-verify.sh` | Called explicitly by the lead | Reads the orchestration journal; exits non-zero when steps are incomplete or artifacts missing. NOT auto-registered. |
| `session-start-doc-check.sh` | SessionStart | Advisory nudge when HEAD diverges from `.canon/last-scribe-commit`. |
| `session-start-kg-check.sh` | SessionStart | Advisory nudge when `.canon/knowledge-graph.db` is missing or stale. |
| `post-engineer-scribe.sh` | SubagentStop | After `engineer` completes, writes `pending-scribe.json` so the lead runs scribe before flow completion. |

`completion-verify.sh` is intentionally NOT registered in `hooks.json`
— registering it as PostToolUse would fire on every Bash call. It is
invoked explicitly by the lead per the CLAUDE.md completion checklist
(phase1-09).

**Where the resolution lives.** The workspace copy of the PLAN file at
`.canon/workspaces/agent-teams-v2/plans/phase1/phase1-07-PLAN.md` has
been amended in place to list all 5 scripts and reflect the actual
shipped scope. Because `.canon/` is gitignored (per-dev workspace),
this committed doc is the source-controlled record of the scope
resolution.

### phase1-10 should audit against this resolution

When `phase1-10` (cross-artifact validation) runs, it must measure
Gate A's "5 hook scripts exist" criterion against the list above,
not against any earlier 2-hook wording. DESIGN.md dc-05 and v2.md
§10.1 are the authoritative scope; this doc records that fact.
