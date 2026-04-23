---
task_id: "v2_1a-03"
wave: 3
depends_on: ["v2_1a-01", "v2_1a-02"]
decisions:
  - "dc-04"
files:
  - agents/planner.md
principles:
  - agent-design-before-code
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Rewrite planner agent body for v2.1 iterate-until-approved

### Action

Rewrite `agents/planner.md` to load the `canon:plan` and `canon:synthesize` native Claude Code skills (from v2_1a-01, v2_1a-02), emit `planning-brief.md` + `runbook.md` per build request using the templates at `templates/planning-brief.md` and `templates/runbook.md`, and run the iterate-until-approved loop.

**Frontmatter (v2.1):**

```yaml
---
name: planner
description: >-
  Produces planning briefs and synthesizes plan-specific runbooks from the
  canonical step vocabulary. Iterates with the user until approval. Does NOT
  write code.
model: opus
color: green
memory: project
maxTurns: 80
permissionMode: plan
skills:
  - canon:plan
  - canon:synthesize
rules:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
  - agent-context-check
  - agent-template-required
references:
  - status-protocol
tools:
  - Read
  - Glob
  - Grep
  - WebFetch
  - mcp__canon__get_principles
  - mcp__canon__get_file_context
  - mcp__canon__graph_query
  - mcp__canon__semantic_search
---
```

**PLAN amendment note** (2026-04-23, pre-ship NF-1): `maxTurns` bumped from 40 to 80. v2_1a-08 validation found S4 (migration, 39 tool calls) and S5 (test-gap, 32 tool calls) exhausted the 40-turn budget investigating the codebase without producing output. The 2× bump tests the capacity hypothesis — if 80 turns suffices, the exhaustion was a budget shortfall; if not, architectural budget-awareness (v2_1b-09) is required. See NF-1 in `docs/v2.1a-validation-report.md` §12.

**PLAN amendment note** (2026-04-22, phase1-08.5 + follow-up): the original v2_1a-03 PLAN declared a single `skills:` list mixing two distinct concerns — procedural skills (how to plan, how to synthesize) and Canon rules/references (agent-surface-assumptions, status-protocol, etc.). The corrected model separates them:

- **`skills:`** — Claude Code native skills, preloaded by Claude Code itself. `canon:plan` and `canon:synthesize` are per-skill `SKILL.md`-wrapped directories under `skills/canon/skills/` that v2_1a-01 and v2_1a-02 ship; they encode the planning and synthesis contracts. The planner subagent receives both skills' content at spawn natively.
- **`rules:` / `references:`** — Canon preload fields resolved by `resolve_agent_skills` (phase1-08.5). Rules are imperative agent-behavior; references are protocol fragments. `agent-template-required` is added because the body references two templates.
- **Templates** — `templates/planning-brief.md` (phase1-08) and `templates/runbook.md` (new in v2_1a-02) are the output shapes, named in the body per `agent-template-required`.

**Body (new, replaces any v2-era body):**

- Core principle: `agent-design-before-code` — planner produces a brief + runbook before any code lands
- Process section:
  1. Read the user request and any prior planning artifacts
  2. Produce `${WORKSPACE}/plans/${slug}/planning-brief.md` following the `canon:plan` skill and the `templates/planning-brief.md` template
  3. Produce `${WORKSPACE}/plans/${slug}/runbook.md` following the `canon:synthesize` skill and the `templates/runbook.md` template
  4. Emit `confidence_signals[]` in the runbook frontmatter (per-signal only; no aggregate scalar user-facing per review HIGH-2)
  5. Present brief + runbook to the lead for user presentation
  6. On iteration request: re-spawn with full workspace context; write `runbook-iter-N.md` (v2.1a) or new `lifecycle_synthesized_runbooks` row (v2.1b+); re-score per-signal confidence
  7. On approval: mark the approved runbook (conversational signal; internal record)
- Constructive push-back section: clarifies requirements, challenges assumptions, evaluates alternatives, assesses value — per v2.1 §2.3
- Non-responsibilities section: does NOT write code; does NOT design internal code structure (architect's `design` step); does NOT gate HITL (confidence is advisory, per §7.3)
- Status protocol: `DONE` when runbook is approved; `HAS_QUESTIONS` when blocking open questions exist

### Canon principles to apply

- **agent-design-before-code** — planner is literally the agent that enforces this at the flow level
- **agent-surface-assumptions** — brief's open-questions and alternatives-considered sections are the primary surface
- **agent-evidence-over-intuition** — planner cites KG queries, principle IDs, memory hits; does not emit vibe-check recommendations

### Risk mitigations

- Planner inconsistency (§13 MEDIUM/MEDIUM): body references the synthesis skill strictly; MEDIUM-2 regression suite compares output against skill contracts mechanically
- Intent misclassification drift (§13 MEDIUM/MEDIUM): planner only runs when lead classifies build intent; L1 + L4 handle the classification upstream
- LLM overconfidence (§13 MEDIUM/HIGH): body explicitly forbids emitting the aggregate confidence scalar user-facing; per-signal only

### Tests to write

No existing test infrastructure for agents/*.md. Validation is by:

- Manual read: frontmatter matches spec (`rules` / `references` / `tools` fields populated, maxTurns 40, model opus, permissionMode plan, memory project); body references both skill files by name; no Edit/Write/Bash calls in body (read-only by permissionMode)
- Integration (part of v2_1a-08 validation): spawn planner against a representative build request; confirm `planning-brief.md` + `runbook.md` produced at expected paths; runbook carries `confidence_signals[]` frontmatter; no aggregate scalar in user-facing output

### Verify

1. `agents/planner.md` parses as agent definition
2. Frontmatter matches spec: `skills: [canon:plan, canon:synthesize]` (native), `rules:` and `references:` populated per spec, `tools:` list correct
3. `canon:plan` and `canon:synthesize` resolve as native Claude Code skills — i.e., `skills/canon/skills/plan/SKILL.md` and `skills/canon/skills/synthesize/SKILL.md` exist and are discovered by Claude Code (shipped by v2_1a-01 and v2_1a-02)
4. `resolve_agent_skills` returns zero `unresolved` entries for the planner's `rules:` and `references:`
5. Body cites `templates/planning-brief.md` and `templates/runbook.md` as output shapes (agent-template-required)
6. Agent tests pass: `npm test -- planner`
7. Manual spawn against 2-3 test requests produces expected artifacts

### Done when

- Agent definition rewritten; tests pass
- Integration test with v2_1a-01 and v2_1a-02 skills produces brief + runbook matching contracts
- No stale v2-era scaffolding (conditional spawn, single-artifact output, etc.) remains in body
- Agent is invokable via `Agent` tool under `CANON_AGENT_TEAMS_MODE=on`
