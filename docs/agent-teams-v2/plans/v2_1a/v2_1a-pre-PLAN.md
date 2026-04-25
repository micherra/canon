---
task_id: "v2_1a-pre"
wave: 0
depends_on: []
decisions:
  - "dc-01"
  - "dc-07"
files:
  - docs/v2.1a-preflight.md
principles:
  - agent-evidence-over-intuition
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: v2.1a pre-flight — environment verification before Wave 1

### Action

Before v2.1a Wave 1 tasks execute, run a short pre-flight verification and document results in `docs/v2.1a-preflight.md`. This task absorbs findings from the fresh-eyes architect review (see commits amending this task tree) that require environment facts the plan authors could not confirm without filesystem access.

**Verification items:**

1. **Gate A state** — confirm `planner` and `engineer` agent definitions exist in `agents/`. If either is absent, Gate A is not met and v2.1a must not begin. v2's `phase1-08` is the task that creates them; check its status. If phase1-08 has landed but the agents don't exist, flag that gap.

2. **phase1-10 amendment status** — v2's `phase1-10` is the validation task that Gate A depends on. Under v2.1, phase1-10's scope has changed: it validates planner + engineer + skills preloading, NOT the 5 static runbooks (which are abandoned). Per `.canon/workspaces/agent-teams-v2/plans/phase1/INDEX.md`, phase1-10 is tagged REFACTORED per v2.1 §10.5, but the PLAN file itself may not yet reflect the amended scope. **If phase1-10-PLAN.md still references static-runbook validation, file a remediation task to rewrite it against v2.1 §10.5 criteria before phase1-10 executes.**

3. **writer / learner current frontmatter** — v2_1a-06 amends both agents to expect workspace paths. Read current `agents/writer.md` + `agents/learner.md`:
   - Confirm tools list (should already include `Write`, `Edit` for writer to justify v2_1a-06's "no permissionMode change" claim)
   - Confirm no existing `permissionMode: plan` restriction that would need to be removed
   - Document current body structure so v2_1a-06 amendments are additive, not replacing
   - Note any existing uses that might be affected by the workspace-path expectation

4. **Test-path conventions** — confirm mcp-server uses `__tests__/` directories (not colocated `.test.ts`). Grep: `find mcp-server/src -name "*.test.ts"` → should show all paths under `__tests__/`. Confirm templates/ and agents/ have no test infrastructure (search for `test` / `spec` patterns). Confirm skills/ has no test infrastructure. Any PLAN that cites a non-`__tests__/` code-test path or an agent/template/skill test path is wrong and must be amended before Wave 1.

5. **`.canon/workspaces/` tracking pattern** — confirm existing phase1/ plan files are git-tracked (via `git ls-files .canon/workspaces/agent-teams-v2/plans/phase1/`). This documents the precedent for v2.1a/b plan-file tracking (force-add, since `.canon/` is gitignored globally). If the tracking pattern differs or is no longer desired, flag before v2.1a commits land.

6. **Drift-db migration-runner convention** — inspect `mcp-server/src/platform/storage/drift/` to confirm:
   - Existing `migrations/` directory pattern (expected path for v2_1b-00's new migration file)
   - Schema version constant location (v2_1b-00 bumps this)
   - Existing migration's `up()` / `down()` shape so v2_1b-00 matches the convention

7. **Worktree metadata `parent_workspace_id` field** (for ISSUE-3 v2_1a-05 L4 parent-lookup rule) — confirm whether Canon's existing worktree convention records the parent-workspace link. If not, v2_1a-05 has an implicit dependency on adding this field. Document current state; file remediation task if gap exists.

### Canon principles to apply

- **agent-evidence-over-intuition** — pre-flight produces evidence (filesystem facts), not assumption-based planning
- **agent-surface-assumptions** — documents every environment assumption that downstream tasks depend on

### Risk mitigations

- Surfaces all environment gaps BEFORE Wave 1 execution, preventing mid-wave surprises

### Tests to write

This is a verification task. The report IS the output.

### Verify

1. `docs/v2.1a-preflight.md` exists with findings for each of the 7 verification items
2. Any remediation tasks filed (e.g., phase1-10 amendment, worktree metadata addition, convention migration) have task IDs and are tracked
3. Go / no-go decision for Wave 1: documented

### Done when

- Report committed
- Any remediation tasks filed as follow-up PLAN files (could be `v2_1a-pre-NN-PLAN.md` or under a new sub-tree)
- Go / no-go call made by Canon maintainer
- If remediations block: Wave 1 does not start until they clear
