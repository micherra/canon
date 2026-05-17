---
template: runbook
description: Synthesized runbook produced by the architect agent (canon:synthesize skill). Defines the ordered step sequence that the orchestrator executes.
used-by: [architect]
read-by: [canon-orchestrator, engineer, reviewer, scribe, learner]
output-path: ${WORKSPACE}/plans/${slug}/runbook.md
---

# Template: Runbook

Use this template when the architect synthesizes a runbook from its design. The architect produces both the design document (DESIGN.md) and the runbook as paired artifacts. The runbook defines the ordered sequence of steps the orchestrator executes. Follow the structure exactly — downstream agents and the orchestrator parse this file structurally.

```markdown
---
runbook: ${slug}
flow: {fast-path | feature | refactor | migrate | epic}
tier: {fast-path | feature | refactor | migrate | epic}
created: ${timestamp}
iteration: {N}
confidence_signals:
  - dimension: scope
    level: {high | medium | low}
    rationale: >-
      {One sentence explaining why this confidence level was assigned to this dimension.}
  - dimension: step-sequence
    level: {high | medium | low}
    rationale: >-
      {One sentence explaining why this confidence level was assigned to this dimension.}
  - dimension: contract-pairings
    level: {high | medium | low}
    rationale: >-
      {One sentence explaining why this confidence level was assigned to this dimension.}
status: draft | approved | locked | completed
---

# Runbook: {request-title}

## Overview

{One paragraph explaining why this specific step sequence was chosen. Do not list the steps — explain the rationale. Address the scope from the planning brief, the risk profile, and why optional steps were included or skipped. This paragraph is the synthesis justification; it is read by the user during approval and by the learner during retrospective.}

## Steps

### Step 1: {id}

```yaml
id: {step-id}
agent: {agent-type | null}
dispatch: {subagent | team | n/a}
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/{path}
hitl: {none | approval | checkpoint | on_failure}
skip_when: ~
```

**Intent:** {What this step is trying to achieve in the context of this specific runbook. Not a generic description of the step type — explain why it appears here, what question it answers, or what risk it addresses.}

**Skip-when elaboration:** {If skip_when is set, elaborate on the condition. When does it trigger? What is skipped in its place? What are the implications? If skip_when is null/~, omit this paragraph.}

**Coordination notes:** {Hand-off signals to the next step. Which artifacts does the next step consume? What HITL checkpoint does the user see here? What must pass for the orchestrator to proceed?}

---

### Step 2: {id}

```yaml
id: {step-id}
agent: {agent-type | null}
dispatch: {subagent | team | n/a}
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/{path}
hitl: {none | approval | checkpoint | on_failure}
skip_when: ~
```

**Intent:** {What this step achieves in context.}

**Skip-when elaboration:** {Condition elaboration, or omit if skip_when is null.}

**Coordination notes:** {Hand-off and HITL details.}

---

{... repeat ### Step N: {id} sections for each step in the runbook ...}

---

### Step {N}: review (example)

```yaml
id: review
agent: reviewer
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/reviews/REVIEW.md
hitl: checkpoint
skip_when: ~
```

**Intent:** {What this review is assessing — principle compliance, drift from plan, or targeted scope. Explain why review appears at this point in the runbook.}

**Coordination notes:** The reviewer writes its output to `${WORKSPACE}/reviews/REVIEW.md`. The orchestrator must inject `WORKSPACE={workspace_path}` (the workspace root, not the worktree path) into the reviewer's spawn prompt so the artifact lands in the workspace, not inside the worktree. After the reviewer completes, verify the file exists before proceeding.

---

## Mandatory Tail

The following three steps close every build runbook. They are always present — not skippable, not reorderable.

### Step {N}: context-sync

```yaml
id: context-sync
agent: scribe
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/context-sync-report.md
hitl: none
skip_when: ~
```

**Intent:** The scribe updates CLAUDE.md, context.md, and CONVENTIONS.md to reflect any contract-level changes that occurred during this flow. Keeps project documentation current so the next flow starts with accurate context. Runs before `ship` so that doc updates are committed to the build branch and included in the PR — the scribe needs the worktree available to commit doc updates before the PR is created.

**Coordination notes:** Runs after all functional steps complete. Produces `context-sync-report.md`. The `ship` step follows immediately.

---

### Step {N+1}: ship

```yaml
id: ship
agent: shipper
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - "outcome:PR created for worktree branch"
hitl: on_failure
skip_when: ~
```

**Intent:** The shipper creates a PR from the worktree branch (`canon/{slug}`) to main. Direct merge is the fallback mode — used only when the user explicitly requests it (e.g., "merge it", "skip PR").

**Coordination notes:** Runs after `context-sync` so that documentation updates land on the build branch before the PR is created. The shipper must NOT run `git worktree remove` — `finalize_workspace` needs the worktree for artifact verification. The shipper does NOT delete the build branch — it is needed for the PR. On conflict (fallback merge path only), blocks until the user resolves. The `learn` step follows immediately.

---

### Step {N+2}: learn

```yaml
id: learn
agent: learner
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - "outcome:learning analysis complete"
hitl: none
skip_when: ~
```

**Intent:** The learner analyzes the completed flow for patterns — recurring fix cycles, contract pairing gaps, vocabulary stretches — and proposes principle improvements. In auto-trigger mode, writes proposals to `.canon/proposed-learnings/`. In manual mode, writes `.canon/LEARNING-REPORT.md`. The output feeds Canon's continuous improvement loop.

**Coordination notes:** Final step. In auto-trigger mode, produces proposals in `.canon/proposed-learnings/{timestamp}/`. In manual mode, produces `.canon/LEARNING-REPORT.md` and appends to `.canon/learning.jsonl`. No subsequent steps; orchestrator transitions to `complete_flow` after this step.
```

---

## Conventions

- **Frontmatter `status` lifecycle:** `draft` (just synthesized) → `approved` (user approved) → `locked` (orchestrator locked for execution) → `completed` (all steps done).
- **Iteration numbering:** Start at `1`. Each revision that goes back to the user for approval increments `iteration`. Persist prior iterations as `runbook-iter-{N}.md` in the workspace — never overwrite.
- **`confidence_signals[]`:** Required in frontmatter. Per-signal objects only — no top-level `confidence:` scalar. Each signal covers one dimension of synthesis uncertainty. See `canon:synthesize` skill for the full list of suggested dimensions and guidance on level assignment.
- **Step YAML blocks:** Use literal YAML fenced code blocks per step (not prose lists). The orchestrator and journal tooling parse these blocks structurally.
- **Artifacts paths:** Use `${WORKSPACE}/` prefix for all artifact paths. Use `${slug}` and `${task_id}` where the runbook's identity must appear in the path. For steps that produce no file output but have a verifiable result, use the `outcome:` sentinel instead of a path — for example: `artifacts: ["outcome:all existing tests pass"]`. Paths and outcome sentinels may coexist in the same list.
- **Override documentation:** When a step's `agent`, `dispatch`, or `hitl` differs from the vocabulary default, the step's **Intent** paragraph must explain the justification. Silent overrides are synthesis errors.
