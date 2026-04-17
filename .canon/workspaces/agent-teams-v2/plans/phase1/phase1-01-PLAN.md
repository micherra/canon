---
task_id: "phase1-01"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/fast-path.md
principles:
  - agent-plans-are-prompts
domains:
  - orchestration
---

## Task: Create fast-path runbook

### Action

Create `skills/canon/runbooks/fast-path.md` conforming to `templates/runbook-template.md`. This is the simplest runbook — single-agent, no research, no architecture, no waves.

1. Read `flows/fast-path.md` for the legacy state machine definition. The flow has these states:
   - `execute` (single, canon-engineer) — implement, test, self-review, commit
   - `pre-launch-check` (single, no agent) — run discovered quality gates
   - `ship` (single, canon-shipper) — synthesize PR description
   - `learn` (single, canon-learner, skip_when: learn_gate_not_passed) — auto-trigger pattern analysis

2. Read `templates/runbook-template.md` for the field reference and body structure.

3. Write `fast-path.md` as markdown with YAML frontmatter. The frontmatter declares each step's structured metadata; the body contains an H3 subsection per step with the per-step guidance the lead interprets at dispatch time. Per `templates/runbook-template.md` and DESIGN.md §1, **body prose is the guidance container** — there is no `notes:` frontmatter field. Per DESIGN.md §1 and §4 of the migration plan, fast-path includes `context-sync` as a mandatory step before `ship`, even for single-agent flows (documentation must reflect contract-level changes regardless of flow size).

**Frontmatter shape (5 steps):**

```yaml
name: "fast-path"
description: "Single-agent fast path — implement, test, self-review in one pass"
tier: "small"

steps:
  - id: "execute"
    agent: "canon-engineer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/SUMMARY.md"
    hitl: "on_failure"
    skip_when: null

  - id: "pre-launch-check"
    agent: null
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: null

  - id: "context-sync"
    agent: "canon-scribe"
    dispatch: "subagent"
    mcp_tools: []
    artifacts:
      - "plans/${slug}/CONTEXT-SYNC.md"
    hitl: "none"
    skip_when: "all changes are internal/test-only/config"

  - id: "ship"
    agent: "canon-shipper"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - update_board
    artifacts:
      - "plans/${slug}/PR-DESCRIPTION.md"
    hitl: "on_failure"
    skip_when: null

  - id: "learn"
    agent: "canon-learner"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - get_drift_report
    artifacts:
      - ".canon/proposed-learnings/${timestamp}/"
    hitl: "none"
    skip_when: "learn gate thresholds not met"
```

**Body (required sections):**

- `# Fast-Path Runbook` — title
- `## Overview` — one paragraph on when fast-path is chosen (clear bug fix / small change with obvious scope, lead bypasses the pre-build gate per §2.3 of the migration plan)
- `## Steps` — one H3 subsection per frontmatter step ID, in the same order. Each H3 covers intent, composition hints beyond `mcp_tools`, and `Skip when:` elaboration. Follow the authoring rule from `skills/canon/runbooks/README.md` — body prose does NOT restate `mcp_tools` or `artifacts`:
  - `### execute` — fast-path single-agent mode. The engineer handles implementation (TDD), test verification, self-review against Canon principles, and commit in one pass. Summary MUST include a `### Self-Review` section with Canon principle compliance declarations and a `### Verification` section confirming all tests pass. Skip when: never.
  - `### pre-launch-check` — gate-only step, no agent spawned. The lead collects all quality-check commands (test, lint, build) discovered in the execute summary and runs them via Bash. If any fail, present to user. If no gates discovered, fail closed. Skip when: never.
  - `### context-sync` — surgical post-implementation doc update. Scribe reads git diff + execute summary and edits CLAUDE.md / context.md / CONVENTIONS.md only where contracts changed. Skip when: classification returns NO_UPDATES (all changes internal / test-only / config).
  - `### ship` — synthesize build artifacts into a PR description. Shipper reads `session.json`, `board.json`, `SUMMARY.md`, runs `git log` for commit history, checks `CHANGELOG.md` for format detection. Skip when: never.
  - `### learn` — auto-trigger pattern analysis. Learner reads transcripts + drift data, writes proposals to `.canon/proposed-learnings/${timestamp}/` when actionable signal exists. Skip when: learn gate thresholds not met.
- `## Completion` — the 4-item completion checklist from `templates/runbook-template.md`.

4. Validate the file matches `templates/runbook-template.md`: frontmatter parses as YAML, required body sections present, every `steps[].id` has a matching `### {id}` heading, no stray `{slug}` / `{task_id}` / `{timestamp}` placeholders (must use `${slug}` / `${task_id}` / `${timestamp}`).

### Canon principles to apply
- **agent-plans-are-prompts**: The body H3 prose is spawn-prompt context the lead reads and adapts. It must be actionable — not a restatement of the agent definition, but specific instructions for this flow context.

### Tests to write
- No code tests. YAML validation only.

### Verify
1. File exists at `skills/canon/runbooks/fast-path.md`
2. Frontmatter parses as valid YAML
3. Steps cover all 4 legacy states from `flows/fast-path.md` (execute, pre-launch-check, ship, learn) plus the mandatory `context-sync` step
4. Every step has all required fields per `templates/runbook-template.md` (`id`, `agent`, `dispatch`, `mcp_tools`, `artifacts`, `hitl`; `skip_when` optional)
5. Body has `## Overview`, `## Steps`, `## Completion` sections and one `### {id}` heading per frontmatter step
6. No stray `{slug}` / `{task_id}` / `{timestamp}` placeholders
7. `npm run build` passes (no TypeScript changes)
8. `npm test` passes (no test changes)

### Done when
- `fast-path.md` exists and frontmatter parses as valid YAML
- All 4 legacy states + mandatory `context-sync` are represented as steps with correct agents, dispatch types, and artifacts
- Body H3 prose for `execute` includes the self-review and verification requirements from the legacy spawn instructions
- Build and tests pass unchanged
