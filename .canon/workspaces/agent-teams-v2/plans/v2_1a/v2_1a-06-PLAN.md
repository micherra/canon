---
task_id: "v2_1a-06"
wave: 2
depends_on: []
decisions:
  - "dc-07"
files:
  - CLAUDE.md
  - agents/canon-writer.md
  - agents/canon-learner.md
  - skills/canon/references/content-flow.md
principles:
  - agent-design-before-code
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Intent-routing expansion for non-build Canon intents (review HIGH-1 prerequisite for L4)

### Action

Expand Canon's intent-routing surface so that every Canon intent that edits tracked files routes through a workspace-creating flow. This is the architect-review HIGH-1 prerequisite that must complete before L4 (v2_1a-05) ships; otherwise L4 blocks legitimate `canon-writer` / `canon-learner` activity.

**Rationale** (from the L4 review discussion captured in `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1): if "any change to a tracked file belongs in a Canon flow" is the principle, then the intents that today edit tracked files without creating workspaces must be expanded to create workspaces. Three in-scope intents:

- **`principle`** — `canon-writer` edits `principles/*.md` (tracked)
- **`learn`** — `canon-learner` writes to `.canon/proposed-learnings/` (gitignored, so arguably out of L4 scope) but may also edit tracked files as part of applying accepted proposals
- **`docs`** — any future docs-only intent that edits `docs/*.md` or other tracked documentation

**Scope:**

1. **CLAUDE.md dispatch table amendment** — in the flag-gated Orchestration section, extend the intent → action table:

   | Intent | Action |
   |--------|--------|
   | `build` | Route to `canon-planner`; planner + approved runbook → execution |
   | `principle` | Route to `canon-writer` within a **workspace-creating content flow** — planner-style brief, synthesized runbook that includes principle-edit steps |
   | `learn` | Route to `canon-learner`; spawn with workspace context so applied refinements have a record |
   | `docs` | Route to a **content flow** (shared with `principle` / docs-only variants): planner-style brief, synthesized runbook focused on doc edits |

2. **Shared "content flow" pattern** — create `skills/canon/references/content-flow.md` that documents a lightweight synthesized-runbook pattern for non-`build` Canon intents. Steps vocabulary is the same as `build` (from v2_1a-00); what changes is which steps are typical (`research` → `content-edit` (mapped to `implement` with `skills: content-authoring`) → `review` → `context-sync` → `learn`). No code-step defaults (`design`, `test`, `security`) for content flows.

3. **`canon-writer` agent body amendment** — agent now expects a workspace path in its spawn prompt, produces an `implementation-log.md` at `${WORKSPACE}/plans/${slug}/` documenting what principle(s) it edited. **No `permissionMode` change required** — `canon-writer` already has `Write`, `Edit`, `Bash` in its `tools` list and no explicit `permissionMode` (defaults apply); it was already a write-capable agent. The amendment is purely behavioral: expect a workspace path, log the edit. Verify in `agents/canon-writer.md` before executing this task that current frontmatter matches this understanding; if it differs, amend this plan first rather than blindly applying.

4. **`canon-learner` agent body amendment** — when the learner is spawned as part of applying an accepted proposal (rather than mining), it must receive a workspace path. Today's learner runs without one for proposal generation (writing to `.canon/proposed-learnings/`, which is gitignored); that continues for mining. For *application*, learner uses the same workspace-creating content flow as `canon-writer`.

5. **`init_workspace` MCP tool** — confirm the tool accepts an `intent_class` argument (`build` | `principle` | `learn` | `docs`) and creates the correct workspace layout. If the tool currently hardcodes `build`, add the argument as non-breaking default-preserving.

### Canon principles to apply

- **agent-design-before-code** — intent-routing expansion is a design-layer change; this task specifies the routing table before any hook change depends on it
- **agent-surface-assumptions** — the assumption "only `build` intent creates workspaces" is surfaced and inverted explicitly

### Risk mitigations

- Intent misclassification drift (§13 MEDIUM/MEDIUM): expanded routing means more intents produce a workspace, which means L4's "active workspace for the current flow" check succeeds more often for legitimate work
- Claude doesn't consistently follow orchestration guidance (§13 HIGH/MEDIUM): the extended dispatch table is more visible in CLAUDE.md, reducing chance of silent mis-routing

### Tests to write

- `skills/canon/references/__tests__/content-flow.test.ts`:
  - content-flow.md parses as a skill file
  - Does not reintroduce step IDs outside the vocabulary from v2_1a-00
- No automated tests for agent-definition markdown (Canon has no `agents/__tests__/` test infrastructure today). Verification is by manual read + the integration test below.
- Manual read of `agents/canon-writer.md` + `agents/canon-learner.md` post-amendment: bodies reference workspace contract; canon-learner differentiates mining vs. application flows.
- Integration test (runs in v2_1a-08 validation):
  - Running `canon-writer` against a test principle produces a workspace at `.canon/workspaces/<slug>/` with `plans/${slug}/implementation-log.md`
  - Running `canon-learner` in application mode produces a workspace and an `implementation-log.md`
  - Both pass L4 (v2_1a-05) when that hook is active

### Verify

1. CLAUDE.md dispatch table extended with `principle`, `learn`, `docs` routing
2. `skills/canon/references/content-flow.md` exists and is registered
3. `canon-writer` and `canon-learner` frontmatter / body updated
4. `init_workspace` accepts `intent_class` argument
5. Integration test: canon-writer run produces workspace at expected path with expected artifacts
6. No regression: existing `build` flows still work (run at least one build test)

### Done when

- All 5 scope items land
- Integration tests pass
- This task completes BEFORE v2_1a-05 (L4 hook) is registered in `hooks.json`
- Review HIGH-1 resolution documented in `docs/agent-teams-migration-plan-v2.1-review.md` or a follow-up note, citing this task ID
