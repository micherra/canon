# Phase 2 Smoke Test Log

Status: passed (foundation-level) on 2026-04-10.
Branch: `canon/agent-teams-phase-2` (descended from the Phase 1 tip at
commit `7e38b63`).
Related: `docs/agent-teams-migration-plan.md` §6, `docs/phase-1-smoke-test.md`,
`docs/phase-2-conversion-notes.md`.

This document captures the end-to-end smoke test for Phase 2 of the
Canon → agent teams migration. Phase 2 adds wave-scoped path support to
`lead-mode.ts`, extends the spawn module with `WAVE_ARTIFACT_SUFFIXES`
and `resolveWaveArtifactPath`, and converts six legacy flows to
runbooks: `feature`, `refactor`, `migrate`, `test-gap`, `review-only`,
`security-audit`.

---

## 1. Scope

### In scope for this smoke test

- Loading every runbook under `skills/canon/runbooks/` (7 total:
  `fast-path` from Phase 1 plus six Phase 2 conversions) via
  `loadAndPlan`.
- Planning each runbook against a disposable workspace and writing the
  hook state files.
- Wave expansion of the three wave-bearing runbooks (`feature`,
  `refactor`, `migrate`) with three synthetic task ids.
- Simulated artifact creation for every descriptor, including every
  wave-expanded per-task path.
- Hook validation (positive + negative) on at least one wave-scoped
  artifact path.
- Phase 1 fast-path smoke test re-run on the Phase 2 branch.
- Full `npm test` and `npm run build` regression vs the pre-Phase-2
  baseline, verifying no new failures attributable to Phase 2.
- Feature-flag gate check: with `CANON_AGENT_TEAMS_MODE` unset, the
  existing `drive_flow` path must not import any Phase 2 code.

### Explicitly out of scope

- **Live Claude Code team lead execution.** Agent teams requires a
  Claude Code v2.1.32+ runtime with
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; not run here. The planner +
  hook state path is fully exercised.
- **Adaptive wave planning.** Phase 2 seeds synthetic task ids at plan
  time; the architect's plan-index output is not parsed to drive the
  wave. This is punted to Phase 3.
- **Phase 3 / Phase 4 flows** (epic, adaptive waves, deletion of the
  legacy flow runtime).

---

## 2. Fixture setup

The Phase 2 smoke harness (`mcp-server/scripts/phase-2-smoke-test.mjs`)
creates one disposable workspace per runbook under `$TMPDIR` with the
same subdirectory layout `init_workspace` writes today:

```
/tmp/canon-phase-2-<runbook>-<hash>/
├── progress.md
├── research/
├── plans/
├── reviews/
└── decisions/
```

Environment:

```bash
export CANON_AGENT_TEAMS_MODE=on
```

Fixture wave context (seeded by the harness for every wave runbook):

```ts
{
  slug: "fix-search-bug",
  task_ids: ["t1", "t2", "t3"],
}
```

Target files (pinned into the spawn prompts):

```
src/example.ts
src/example.test.ts
```

---

## 3. Smoke test harness

The harness at `mcp-server/scripts/phase-2-smoke-test.mjs` imports
`lead-mode.ts` via `tsx`, loads each runbook, plans a run, writes the
state files, simulates artifact creation, and prints the workspace
tree. It is advisory-only and produces no persistent side effects
outside `$TMPDIR`.

The Phase 1 harness (`mcp-server/scripts/phase-1-smoke-test.mjs`) is
left **untouched** per the Phase 2 additive policy.

Run:

```bash
cd mcp-server
./node_modules/.bin/tsx scripts/phase-2-smoke-test.mjs
```

---

## 4. Runbook planner output

### 4.1 Summary

```
fast-path        descriptors=4  wave=false
feature          descriptors=9  wave=true
refactor         descriptors=9  wave=true
migrate          descriptors=10 wave=true
test-gap         descriptors=3  wave=false
review-only      descriptors=1  wave=false
security-audit   descriptors=2  wave=false
```

**7/7 runbooks planned and wrote state cleanly.**

Wave expansion verified: `feature`, `refactor`, and `migrate` each
expand three wave implementors (one per fixture task id). Phase 1's
flat-path task-id convention is preserved for all non-wave steps.

### 4.2 Per-runbook descriptor listings

#### fast-path (Phase 1, re-verified on Phase 2 branch)

```
- fast-path-00-canon-researcher   → research/SYNTHESIS.md   hitl=false
- fast-path-01-canon-architect    → plans/INDEX.md          hitl=after
- fast-path-02-canon-implementor  → plans/SUMMARY.md        hitl=false
- fast-path-03-canon-reviewer     → reviews/REVIEW.md       hitl=after_if_verdict_not_clean
```

Artifact tree:

```
agent-teams/
  task-artifacts.json
  teammate-artifacts.json
plans/
  INDEX.md
  SUMMARY.md
research/
  SYNTHESIS.md
reviews/
  REVIEW.md
```

Identical shape to `docs/phase-1-smoke-test.md` §4.4. Phase 2 changes
do not regress Phase 1 fast-path behavior.

#### feature (wave expanded × 3)

```
- feature-00-canon-researcher                     → research/SYNTHESIS.md            hitl=false
- feature-01-canon-architect                      → plans/INDEX.md                   hitl=after
- feature-fix-search-bug-t1-canon-implementor     → plans/fix-search-bug/t1-SUMMARY.md  hitl=false  [wave]
- feature-fix-search-bug-t2-canon-implementor     → plans/fix-search-bug/t2-SUMMARY.md  hitl=false  [wave]
- feature-fix-search-bug-t3-canon-implementor     → plans/fix-search-bug/t3-SUMMARY.md  hitl=false  [wave]
- feature-03-canon-tester                         → reviews/TEST-REPORT.md           hitl=false
- feature-04-canon-scribe                         → decisions/CONTEXT-SYNC.md        hitl=false
- feature-05-canon-reviewer                       → reviews/REVIEW.md                hitl=after_if_verdict_not_clean
- feature-06-canon-shipper                        → plans/SHIP.md                    hitl=false
```

Artifact tree:

```
agent-teams/
  task-artifacts.json
  teammate-artifacts.json
decisions/
  CONTEXT-SYNC.md
plans/
  INDEX.md
  SHIP.md
  fix-search-bug/
    t1-SUMMARY.md
    t2-SUMMARY.md
    t3-SUMMARY.md
research/
  SYNTHESIS.md
reviews/
  REVIEW.md
  TEST-REPORT.md
```

All three per-task wave artifacts landed at their expanded
`plans/fix-search-bug/t<N>-SUMMARY.md` paths. No collisions.

#### refactor (wave expanded × 3)

```
- refactor-00-canon-researcher                      → research/SYNTHESIS.md
- refactor-01-canon-architect                       → plans/INDEX.md          hitl=after
- refactor-fix-search-bug-t1-canon-implementor      → plans/fix-search-bug/t1-SUMMARY.md  [wave]
- refactor-fix-search-bug-t2-canon-implementor      → plans/fix-search-bug/t2-SUMMARY.md  [wave]
- refactor-fix-search-bug-t3-canon-implementor      → plans/fix-search-bug/t3-SUMMARY.md  [wave]
- refactor-03-canon-tester                          → reviews/TEST-REPORT.md
- refactor-04-canon-scribe                          → decisions/CONTEXT-SYNC.md
- refactor-05-canon-reviewer                        → reviews/REVIEW.md       hitl=after_if_verdict_not_clean
- refactor-06-canon-shipper                         → plans/SHIP.md
```

#### migrate (wave expanded × 3)

```
- migrate-00-canon-researcher                      → research/SYNTHESIS.md
- migrate-01-canon-architect                       → plans/INDEX.md          hitl=after
- migrate-fix-search-bug-t1-canon-implementor      → plans/fix-search-bug/t1-SUMMARY.md  [wave]
- migrate-fix-search-bug-t2-canon-implementor      → plans/fix-search-bug/t2-SUMMARY.md  [wave]
- migrate-fix-search-bug-t3-canon-implementor      → plans/fix-search-bug/t3-SUMMARY.md  [wave]
- migrate-03-canon-tester                          → reviews/TEST-REPORT.md
- migrate-04-canon-security                        → reviews/SECURITY.md     hitl=after_if_verdict_not_clean
- migrate-05-canon-scribe                          → decisions/CONTEXT-SYNC.md
- migrate-06-canon-reviewer                        → reviews/REVIEW.md       hitl=after_if_verdict_not_clean
- migrate-07-canon-shipper                         → plans/SHIP.md
```

Includes the security-audit step (`canon-security`,
`task_type=security-audit`) between tester and reviewer. Migration
surface auditing preserved.

#### test-gap, review-only, security-audit (flat, no waves)

```
- test-gap-00-canon-researcher   → research/SYNTHESIS.md
- test-gap-01-canon-tester       → reviews/TEST-REPORT.md
- test-gap-02-canon-reviewer     → reviews/REVIEW.md       hitl=after_if_verdict_not_clean

- review-only-00-canon-reviewer  → reviews/REVIEW.md       hitl=after_if_verdict_not_clean

- security-audit-00-canon-security → reviews/SECURITY.md   hitl=after_if_verdict_not_clean
- security-audit-01-canon-reviewer → reviews/REVIEW.md     hitl=after_if_verdict_not_clean
```

All three flat runbooks plan cleanly without `wave_context`.

---

## 5. Hook execution traces

Hooks were exercised against the `feature` runbook's fixture workspace
(`/tmp/canon-phase-2-feature-<hash>/`) to prove wave-scoped artifact
paths resolve correctly through both `artifact-enforce.sh` and
`idle-backstop.sh`. The Phase 1 smoke doc §5 already covers flat-path
hook behavior — this section exclusively covers the Phase 2 wave
paths.

### 5.1 `artifact-enforce.sh` — positive (wave artifact present)

Input (stdin):
```json
{"task_id":"feature-fix-search-bug-t2-canon-implementor","session_id":"test"}
```

Environment:
```
CANON_AGENT_TEAMS_MODE=on
CANON_WORKSPACE_DIR=/tmp/canon-phase-2-feature-<hash>
```

Result: **exit 0**, no output. Hook looked up the expanded task id
`feature-fix-search-bug-t2-canon-implementor` in
`task-artifacts.json`, found the wave-scoped path
`plans/fix-search-bug/t2-SUMMARY.md`, verified the file is present and
non-empty, and allowed completion. Wave-scoped path resolution working.

### 5.2 `artifact-enforce.sh` — negative (wave artifact deleted)

Same input as above, but `plans/fix-search-bug/t2-SUMMARY.md` was
removed first.

Output:
```
CANON_AGENT_TEAMS: TaskCompleted blocked.
Expected artifact is missing or empty:
  plans/fix-search-bug/t2-SUMMARY.md
Workspace: /tmp/canon-phase-2-feature-<hash>
Task: feature-fix-search-bug-t2-canon-implementor (session test)
Produce the artifact before marking the task complete.
```

Exit: **2**. The hook surfaces the exact wave-scoped path in its
feedback message, not the flat Phase 1 path. This is the primary
Phase 2 wave-path hook validation — it proves `artifact-enforce.sh`
resolves wave paths correctly without any hook changes.

### 5.3 `idle-backstop.sh` — negative (wave teammate went idle)

Input:
```json
{"teammate_name":"feature-fix-search-bug-t2-canon-implementor","team_name":"t1"}
```

Output:
```
CANON_AGENT_TEAMS: TeammateIdle backstop tripped.
Teammate feature-fix-search-bug-t2-canon-implementor (team t1) went idle without producing:
  plans/fix-search-bug/t2-SUMMARY.md
Workspace: /tmp/canon-phase-2-feature-<hash>
Re-prompt the teammate with a pointer to the expected artifact path.
```

Exit: **2**. `teammate-artifacts.json` keyed the expanded task id
(since wave teammates do not share a flat role key), and the hook
found the wave path by direct lookup.

### 5.4 Feature-flag off — no-op

Same input as 5.1 with `CANON_AGENT_TEAMS_MODE=off` (missing artifact
scenario).

Result: **exit 0**, no output. Confirms the flag gate at the top of
the hook short-circuits before any workspace lookup.

### 5.5 Phase 1 flat-path hook validation (re-run)

The Phase 1 harness (`scripts/phase-1-smoke-test.mjs`) was re-run on
the Phase 2 branch with `CANON_AGENT_TEAMS_MODE=on`. Planner output,
state files, and artifact tree match `docs/phase-1-smoke-test.md` §4.4
exactly. Flat-path hook coverage is preserved.

---

## 6. Unit test validation

Run from `mcp-server/`:

```
./node_modules/.bin/vitest run \
  src/features/spawn/ \
  src/features/task-list/ \
  src/features/orchestration/__tests__/lead-mode.test.ts \
  src/features/orchestration/__tests__/lead-mode-wave.test.ts
```

Result: **5 test files, 135 cases, 0 failures** (26 Phase 1 spawn + 40
Phase 2 wave-spawn-prompt + 26 Phase 1 lead-mode + 23 Phase 2 lead-mode-wave
+ 20 Phase 1 task-list). The Phase 1 test files are unchanged byte-for-byte;
Phase 2 coverage landed in new sibling files.

---

## 7. Regression check (full `npm test` and `npm run build`)

Per `docs/agent-teams-migration-plan.md` §8.3 and the Phase 2 task
description: the pre-existing failure set from
`docs/phase-1-smoke-test.md` §7.2 is the ceiling; Phase 2 must not
extend it.

### 7.1 Baseline (pre-Phase-2, flag off)

```
 Test Files  6 failed | 293 passed (299)
      Tests  37 failed | 4730 passed (4767)
```

Failing files on the pre-Phase-2 tip (`7e38b63`):

| File                                                                | Cause                                               |
|---------------------------------------------------------------------|-----------------------------------------------------|
| `src/domains/workspaces/__tests__/wave-lifecycle.test.ts`           | Environmental: `git init`/`git commit` in sandbox  |
| `src/features/knowledge-graph/__tests__/codebase-graph-integration.test.ts` | Environmental: `git commit` in sandbox     |
| `src/features/knowledge-graph/__tests__/kg-embedding.test.ts`       | Environmental: native embedding model cannot load  |
| `src/features/orchestration/__tests__/contract-checker.test.ts`     | Environmental: `file_changed` needs git base commit|
| `src/features/orchestration/__tests__/init-workspace-preflight.test.ts` | Environmental: git state required              |
| `src/features/orchestration/__tests__/init-workspace-worktree.test.ts`  | Environmental: git worktree creation in sandbox |

Note: these six files are a superset of the four listed in
`docs/phase-1-smoke-test.md` §7.2. The difference comes from merges
into the Phase 1 branch between the Phase 1 smoke test and the Phase 2
starting point — `consultation-pipeline-debate.test.ts` and
`drift-db-analytics.test.ts` TS errors have been resolved, while
`kg-embedding`, `contract-checker`, `init-workspace-preflight`, and
`init-workspace-worktree` have surfaced new environmental failures
unrelated to Phase 2. All six current failures are environmental
(git subprocess and native module loading in the sandbox) and all
existed on the Phase 2 starting commit before any Phase 2 code was
written.

Build: **0 TypeScript errors** on the Phase 2 starting tip. The 5
pre-existing TS errors in `consultation-pipeline-debate.test.ts` and
`drift-db-analytics.test.ts` noted in Phase 1 §7.3 have also been
resolved by merges since the Phase 1 smoke test.

### 7.2 Post-Phase-2 (all wave code landed)

```
 Test Files  6 failed | 295 passed (301)
      Tests  37 failed | 4793 passed (4830)
```

**Zero new failures.** The 6 failing files and 37 failing tests
correspond exactly to the environmental baseline above. 63 additional
test cases now pass (the Phase 2 new tests: 40 in
`wave-spawn-prompt.test.ts`, 23 in `lead-mode-wave.test.ts`). Two
additional test files are added to the passing set for the same
reason.

Summary table:

| Metric        | Baseline | Post-Phase-2 | Delta                       |
|---------------|---------:|-------------:|-----------------------------|
| Test files    | 299      | 301          | +2 (new sibling test files) |
| Passing files | 293      | 295          | +2                          |
| Failing files | 6        | 6            | 0                           |
| Test cases    | 4767     | 4830         | +63 (new Phase 2 coverage)  |
| Passing tests | 4730     | 4793         | +63                         |
| Failing tests | 37       | 37           | 0                           |

**Phase 2 introduces zero regressions.** The ceiling is respected.

### 7.3 Build check

```
npm run build
```

**0 TypeScript errors** on the post-Phase-2 commit.

Targeted grep to confirm no new errors reference Phase 2 files:

```
npm run build 2>&1 | grep -E "spawn|task-list|lead-mode|runbook"
```

No output — every Phase 2 file compiles cleanly.

### 7.4 Feature-flag off isolation

```
rg -n "features/spawn|features/task-list|lead-mode|runbooks/" \
   mcp-server/src/features/orchestration/tools/ \
   mcp-server/src/app/
```

**No matches.** The `drive_flow` path does not import any Phase 2
code, so with `CANON_AGENT_TEAMS_MODE` unset the Phase 2 extensions
are never reached.

---

## 8. Summary

- 7/7 runbooks parse, plan, and write state files cleanly
  (`fast-path`, `feature`, `refactor`, `migrate`, `test-gap`,
  `review-only`, `security-audit`).
- Wave expansion verified for `feature`, `refactor`, and `migrate`
  with 3 synthetic task ids each. All per-task artifacts land at
  `plans/<slug>/<task_id>-SUMMARY.md`; no collisions with Phase 1 flat
  paths.
- `artifact-enforce.sh` and `idle-backstop.sh` resolve wave-scoped
  artifact paths correctly for both the positive and negative paths.
  No hook script changes were required — the state files do all the
  routing.
- Phase 1 `fast-path` smoke test re-runs cleanly on the Phase 2 branch.
- 135 unit tests pass across the spawn and orchestration feature
  boundaries (26 Phase 1 spawn + 40 Phase 2 wave-spawn-prompt + 26
  Phase 1 lead-mode + 23 Phase 2 lead-mode-wave + 20 task-list).
- Full `npm test` regression: zero new failures vs baseline. Same six
  environmental failing files, same 37 individual failing tests, 63
  additional passing tests from Phase 2 coverage.
- Full `npm run build`: zero TypeScript errors. No Phase 2 files
  appear in any build output.
- Feature-flag isolation: with `CANON_AGENT_TEAMS_MODE` unset, the
  `drive_flow` path never imports Phase 2 code.

Phase 2 is ready for human review. Phase 3 (epic + adaptive waves) and
Phase 4 (deletion of the legacy flow runtime) remain unstarted and are
tracked in `docs/agent-teams-migration-plan.md`.
