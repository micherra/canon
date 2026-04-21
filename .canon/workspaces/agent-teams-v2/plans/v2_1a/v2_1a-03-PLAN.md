---
task_id: "v2_1a-03"
wave: 3
depends_on: ["v2_1a-01", "v2_1a-02"]
decisions:
  - "dc-04"
files:
  - agents/canon-planner.md
principles:
  - agent-design-before-code
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Rewrite canon-planner agent body for v2.1 iterate-until-approved

### Action

Rewrite `agents/canon-planner.md` to load `planner-brief` and `runbook-synthesis` skills (from v2_1a-01, v2_1a-02), emit `planning-brief.md` + `runbook.md` per build request, and run the iterate-until-approved loop.

**Frontmatter (v2.1):**

```yaml
---
name: canon-planner
description: >-
  Produces planning briefs and synthesizes plan-specific runbooks from the
  canonical step vocabulary. Iterates with the user until approval. Does NOT
  write code.
model: opus
color: green
memory: project
maxTurns: 40
permissionMode: plan
skills:
  - planner-brief
  - runbook-synthesis
  - agent-surface-assumptions
  - agent-evidence-over-intuition
  - agent-context-check
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

**Body (new, replaces any v2-era body):**

- Core principle: `agent-design-before-code` — planner produces a brief + runbook before any code lands
- Process section:
  1. Read the user request and any prior planning artifacts
  2. Load the `planner-brief` skill to produce `${WORKSPACE}/plans/${slug}/planning-brief.md`
  3. Load the `runbook-synthesis` skill to produce `${WORKSPACE}/plans/${slug}/runbook.md`
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

- Manual read: frontmatter matches spec (skills, maxTurns 40, model opus, permissionMode plan, memory project); body references both skill files by name; no Edit/Write/Bash calls in body (read-only by permissionMode)
- Integration (part of v2_1a-08 validation): spawn canon-planner against a representative build request; confirm `planning-brief.md` + `runbook.md` produced at expected paths; runbook carries `confidence_signals[]` frontmatter; no aggregate scalar in user-facing output

### Verify

1. `agents/canon-planner.md` parses as agent definition
2. Frontmatter matches spec
3. Skills referenced (`planner-brief`, `runbook-synthesis`) resolve to files from v2_1a-01, v2_1a-02
4. Agent tests pass: `npm test -- canon-planner`
5. Manual spawn against 2-3 test requests produces expected artifacts

### Done when

- Agent definition rewritten; tests pass
- Integration test with v2_1a-01 and v2_1a-02 skills produces brief + runbook matching contracts
- No stale v2-era scaffolding (conditional spawn, single-artifact output, etc.) remains in body
- Agent is invokable via `Agent` tool under `CANON_AGENT_TEAMS_MODE=on`
