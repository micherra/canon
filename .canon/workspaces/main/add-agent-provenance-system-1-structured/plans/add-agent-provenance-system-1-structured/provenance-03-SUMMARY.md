---
task_id: "provenance-03"
status: "DONE"
commit: "314a1502"
---

### Status

DONE

### What Changed

Integrated the wave 1 provenance modules (`commit-trailers.ts`, `file-claims.ts`) into the orchestration tool surface and agent instructions.

Four integration points implemented:

1. **`init-workspace.ts`** — Added check #3 to `runPreflightChecks`: reads `claims.json` via `readClaims`, reports total claimed files and workflow names as an informational issue string. Non-blocking (try/catch). Exported `runPreflightChecksForTest` for unit testing.

2. **`update-board.ts`** — Two changes:
   - `handleInlineAction` changed from sync to async to support dynamic import of `file-claims.ts`
   - `set_metadata` case: when `input.metadata.affected_files` is present, parses the JSON array and calls `registerClaims` + `checkClaimOverlaps`; overlap warnings are stored in board metadata as `claim_warnings`
   - `handleCompleteFlow`: calls `releaseClaims(projectDir, session.slug)` before recording analytics

3. **`inject-coordination.ts`** — Added step 3.5 injecting a `## Commit Provenance` section into every spawn prompt entry. Uses `formatCommitTrailers` with `workflow` (from session slug), `agent` (from entry), `state_id`, and optional `task_id` (from structured wave item). Non-blocking: returns empty string on session read failure.

4. **`agents/canon-implementor.md`** — Added Canon commit trailer instructions to both Step 5 (incremental commits) and Step 9 (final commit), with example commit messages showing the trailer format.

### Files Modified

| File | Change |
|------|--------|
| `mcp-server/src/features/orchestration/tools/init-workspace.ts` | Modified — added claim overlap check in preflight; exported `runPreflightChecksForTest` |
| `mcp-server/src/features/orchestration/tools/update-board.ts` | Modified — `handleInlineAction` made async; `set_metadata` registers claims + reports overlaps; `handleCompleteFlow` releases claims |
| `mcp-server/src/features/prompt-pipeline/services/inject-coordination.ts` | Modified — added `buildProvenanceSection` + step 3.5 commit provenance injection per prompt entry |
| `agents/canon-implementor.md` | Modified — added commit trailer instructions in Steps 5 and 9 |
| `mcp-server/src/features/orchestration/__tests__/init-workspace-claims.test.ts` | Created — 6 tests |
| `mcp-server/src/features/orchestration/__tests__/update-board-claims.test.ts` | Created — 6 tests |

### Tests Written

**`init-workspace-claims.test.ts`** (6 tests):
1. Reports active claims as informational warning with correct file count and workflow names
2. Reports multiple workflows when claims span different files
3. Produces no claim warning when `claims.json` does not exist
4. Produces no claim warning when claims file is empty (no claims keys)
5. Silently ignores stale claims (>24h, pruned by `readClaims`)
6. Silently ignores corrupt `claims.json` (non-blocking)

**`update-board-claims.test.ts`** (6 tests):
1. Registers file claims when `set_metadata` includes `affected_files`
2. Stores overlap warnings in board metadata when another workflow claims same files
3. Does not touch claims when `set_metadata` has no `affected_files`
4. Is non-blocking when `affected_files` JSON is malformed
5. Releases claims for the workflow on `complete_flow`
6. `complete_flow` is non-blocking even when no claims exist

Total: 12 new tests, all passing.

### Coverage Notes

**Tested Paths:**
- `runPreflightChecks` claim check: active claims warning, no-claims no-warning, stale claims (pruned), corrupt JSON (fallback)
- `set_metadata` with `affected_files`: claims.json written, slug used as workflow, overlap warnings in board.metadata
- `set_metadata` without `affected_files`: claims.json not created
- `set_metadata` with malformed JSON: non-blocking, tool succeeds
- `complete_flow`: slug's claims released, other workflows' claims preserved
- `complete_flow` with no claims: non-blocking

**Known Gaps:**
- `buildProvenanceSection` in `inject-coordination.ts`: not directly unit tested (relies on existing inject-coordination tests not covering this new section). Integration coverage is implicit.
- Wave task `task_id` extraction from structured item: tested at unit level via `extractTaskId` (internally called, not exported). No dedicated test for this path.
- The `inject-coordination.ts` provenance injection is appended after the metrics footer — the ordering relationship isn't tested, only the presence is tested indirectly.

**Risk Mitigation Tests:**
- `handleInlineAction` async change: verified all existing update-board tests still pass (no regressions)
- `JSON.parse` failure on `affected_files`: tested — non-blocking
- Claims operation failure: tested via corrupt JSON and missing files — both non-blocking

### Canon Compliance

- **errors-are-values** (strong-opinion): ✓ COMPLIANT — all claim operations wrapped in try/catch; overlaps produce warning strings in metadata, not errors; preflight issues are string arrays not exceptions; `set_metadata` and `complete_flow` succeed even on claims failures
- **deep-modules** (strong-opinion): ✓ COMPLIANT — integration code delegates entirely to `file-claims.ts` for all logic; `init-workspace.ts` and `update-board.ts` integration is thin (no duplicated claim logic)
- **simplicity-first** (strong-opinion): ✓ COMPLIANT — dynamic import keeps `file-claims.ts` off the critical path of `init-workspace`; warnings are plain strings in `preflight_issues`; provenance section is a simple string append in the existing coordination stage rather than a new stage

### Verification Results

1. New tests: `npx vitest run src/features/orchestration/__tests__/init-workspace-claims.test.ts src/features/orchestration/__tests__/update-board-claims.test.ts` → 12/12 passed
2. Full suite: `npx vitest run` → 4696/4697 passed; 1 pre-existing failure (`domain-priming-integration.test.ts` — README.md in domains/ dir, unrelated to this task)
3. Build: `node node_modules/typescript/bin/tsc --noEmit` → clean (no TypeScript errors)
4. Agent instructions: `agents/canon-implementor.md` has trailer instructions in Step 5 (line 93) and Step 9 (line 172)
