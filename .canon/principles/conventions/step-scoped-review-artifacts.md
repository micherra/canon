---
id: step-scoped-review-artifacts
title: Step-Scoped Review Artifacts — Fan-Out Reviewers Write to Dedicated Paths
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/features/pr-review/**"
    - "mcp-server/src/shared/lib/atomic-write.ts"
    - "agents/**"
    - "CLAUDE.md"
    - "references/**"
tags:
  - concurrency
  - orchestration
  - review-artifacts
---

When a build spawns multiple review agents (parallel fan-out) or when the workspace may be co-driven by concurrent orchestrators, each review step MUST write its primary artifact to a step-scoped path (`reviews/REVIEW-{step_id}.md` + `reviews/REVIEW-{step_id}.meta.json`) by passing the `step_id` parameter to `write_review`. The fixed canonical pair (`reviews/REVIEW.md` + `reviews/REVIEW.meta.json`) is a read-convenience alias, refreshed atomically from the most recent step-scoped pair. The `.md` and `.meta.json` files that constitute a pair MUST always be written in one atomic operation — both temp files written and fsync'd before either rename commits — so no consumer can observe a pair where one file is new and the other is old.

**Implementation reference:** `write_review` MCP tool (PR #416): `step_id` parameter writes `REVIEW-{step_id}.{md,meta.json}` then atomically refreshes the canonical pair via `atomicWritePair` in `mcp-server/src/shared/lib/atomic-write.ts`. Path-traversal safe: `step_id` is validated against `/^[a-zA-Z0-9_-]+$/` before any path join. Backward compat: omitting `step_id` writes canonical-only.

## Rationale

**The 2026-06-24 incident:** Sessions `72f2b372` (R0–R2 consolidated reviewer) and `6429ca3b` (R3 reviewer) both called `write_review` targeting `reviews/REVIEW.md`. The R3 reviewer wrote a CLEAN verdict at 23:32. The consolidated WARNING verdict from R0–R2 (written at 23:29) was silently overwritten. `REVIEW.meta.json` retained the old WARNING verdict while `REVIEW.md` now said CLEAN — a permanently diverged pair. The reviewer team reached a wrong overall verdict because the last-writer-wins race produced an artifact combination that never existed as a consistent state.

Two distinct failure modes compound:

1. **Path collision:** All reviewers write to `reviews/REVIEW.md`. The last write wins, overwriting earlier results without any indication that a prior write existed.
2. **Meta/content divergence:** If a process crashes after writing the `.md` file but before writing `.meta.json`, or if two processes interleave, the verdict in `REVIEW.md` and the verdict in `REVIEW.meta.json` diverge. A consumer that reads only one file gets the wrong answer; a consumer that reads both and detects the mismatch has no way to determine which is correct.

Step-scoped paths eliminate (1) by assigning each reviewer its own artifact. Atomic pair writes eliminate (2) by making the pair transition appear instantaneous — no consumer can observe the intermediate state.

## The Write Protocol

```
# Fan-out build: each reviewer writes to its own path
write_review({ ..., step_id: "review-r1" })
  → writes: reviews/REVIEW-review-r1.md + reviews/REVIEW-review-r1.meta.json  (step-scoped)
  → refreshes: reviews/REVIEW.md + reviews/REVIEW.meta.json (canonical alias, atomic pair)

write_review({ ..., step_id: "review-r2" })
  → writes: reviews/REVIEW-review-r2.md + reviews/REVIEW-review-r2.meta.json
  → refreshes: reviews/REVIEW.md + reviews/REVIEW.meta.json (atomic pair)
```

The consolidation step (Phase 3 of Team Dispatch Protocol) reads all `REVIEW-{step_id}.md` files and writes the final `write_review({ step_id: "consolidate", ... })`, which becomes the canonical pair.

## Examples

**Bad — direct `Write` to `reviews/REVIEW.md` (bypasses step_id scoping and atomicWritePair):**

```typescript
// Reviewer R3 writes directly:
await Write({ file_path: `${WORKSPACE}/reviews/REVIEW.md`, content: r3Findings });
// → clobbers R0-R2 consolidated verdict silently
// → REVIEW.meta.json is now stale (still says WARNING while REVIEW.md says CLEAN)
```

**Bad — `write_review` called twice for the same step (second call overwrites first):**

```typescript
await write_review({ workspace, step_id: "review-r1", verdict: "WARNING", findings: draft1 });
// ... more analysis ...
await write_review({ workspace, step_id: "review-r1", verdict: "CLEAN", findings: draft2 });
// → second call overwrites; draft1 findings are lost
```

**Good — each fan-out reviewer uses a unique step_id:**

```typescript
// Reviewer 1 (session A):
await mcp__canon__write_review({
  workspace: WORKSPACE,
  step_id: "review-r1",
  verdict: "WARNING",
  findings: [ ... ]
});
// → writes: REVIEW-review-r1.md + REVIEW-review-r1.meta.json
// → atomically refreshes: REVIEW.md + REVIEW.meta.json

// Reviewer 2 (session B, concurrent):
await mcp__canon__write_review({
  workspace: WORKSPACE,
  step_id: "review-r2",
  verdict: "CLEAN",
  findings: [ ... ]
});
// → writes: REVIEW-review-r2.md + REVIEW-review-r2.meta.json
// → atomically refreshes: REVIEW.md + REVIEW.meta.json
// Both step-scoped artifacts are preserved; consolidation can read both.
```

**Good — consolidation reads all step-scoped artifacts, writes final:**

```typescript
// After all reviewers complete:
// Read REVIEW-review-r1.md, REVIEW-review-r2.md, REVIEW-review-r3.md
// Merge findings, compute worst-case verdict
await mcp__canon__write_review({
  workspace: WORKSPACE,
  step_id: "consolidate",
  verdict: "WARNING",          // worst-case across R1/R2/R3
  findings: mergedFindings
});
// → canonical REVIEW.md reflects the consolidated verdict
```

## Verification

```bash
# Confirm write_review accepts step_id and writes step-scoped paths:
grep -n "step_id\|REVIEW-\|atomicWritePair" \
  mcp-server/src/features/pr-review/tools/write-review.ts \
  mcp-server/src/shared/lib/atomic-write.ts

# In a workspace with fan-out review, confirm step-scoped artifacts exist:
ls ${WORKSPACE}/reviews/REVIEW-*.md 2>/dev/null | sort

# Confirm no reviewer writes directly to reviews/REVIEW.md via Write tool:
grep -rn '"reviews/REVIEW.md"\|reviews/REVIEW\.md' agents/ references/ CLAUDE.md \
  --include="*.md" | grep -v "# " | grep -v "write_review"
# Expected: zero hits for direct Write calls to the canonical path
```

## Exceptions

- Single-reviewer builds (no fan-out) may omit `step_id` and write canonical-only; the `write_review` call is still required (no direct `Write` to `reviews/REVIEW.md`).
- The `atomicWritePair` invariant applies to all `write_review` calls regardless of fan-out — there is no exception for single-reviewer builds.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "We only have one reviewer — no collision is possible." | Concurrent sessions or background jobs may also write to the workspace. The workspace mutex (OOOOOOOOOO4) reduces this window but does not eliminate it for legitimate multi-session workflows. | Always pass `step_id`. It costs one parameter and prevents a silent clobber. |
| "I'll use a direct `Write` to `reviews/REVIEW.md` — it's simpler." | Direct `Write` bypasses `atomicWritePair`, leaving `REVIEW.meta.json` stale. It also bypasses `step_id` scoping, so the artifact is not preserved for consolidation. | Use `write_review` with `step_id`. |
| "The canonical `REVIEW.md` is authoritative — I only need to read that one." | The canonical pair is a read-convenience alias refreshed by the last `write_review` call. In a fan-out build, the last writer may not be the consolidation step. Read all `REVIEW-{step_id}.md` files during consolidation. | Read step-scoped artifacts during consolidation; read the canonical pair only for the final verdict after consolidation. |

## Related

- [[workspace-mutex-exclusive-init]] (OOOOOOOOOO4) — outer concurrency guard; reduces the concurrent-session window; step-scoped paths are still required for fan-out within a single orchestrator session
- [[session-unique-agent-naming]] (OOOOOOOOOO2) — agent naming prevents `SendMessage` misrouting; complementary to step-scoped artifacts
- [[pre-mutate-reread-gate]] (OOOOOOOOOO3) — re-read gate for git/journal state; the atomic pair write is the review-artifact analog of the same invariant
