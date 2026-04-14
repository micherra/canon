---
task_id: "phase1-02"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/review-only.yaml
  - skills/canon/runbooks/security-audit.yaml
  - skills/canon/runbooks/explore.yaml
principles:
  - agent-plans-are-prompts
domains:
  - orchestration
---

## Task: Create review-only, security-audit, and explore runbooks

### Action

Create three simple runbooks (1-3 steps each). These are the simplest flows after fast-path — no implementation waves, no fix loops.

#### 1. `review-only.yaml`

Read `flows/review-only.md`. States: `review` (single, canon-reviewer), `done` (terminal).

```yaml
name: "review-only"
description: "Review current changes against Canon principles"
tier: "small"

steps:
  - id: "review"
    agent: "canon-reviewer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - review_code
      - get_drift_report
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/REVIEW.md"
      - "reviews/"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Review code changes via git diff. Scope to changed files. For large
      diffs (300+ lines), cluster by architectural layer and fan out as
      parallel subagents (one per layer cluster). Save review to workspace.
      Verdicts: clean (proceed), warning (proceed with notes), blocking
      (present to user for resolution).
```

#### 2. `security-audit.yaml`

Read `flows/security-audit.md`. States: `security` (single, canon-security), `review` (single, canon-reviewer), `done` (terminal). Includes security-scan fragment with `on_critical: hitl`.

```yaml
name: "security-audit"
description: "Security scan followed by principle compliance review"
tier: "small"

steps:
  - id: "security"
    agent: "canon-security"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/SECURITY.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Scan for security vulnerabilities. If critical findings, present to
      user immediately (do not proceed to review). Save assessment to
      workspace using security-assessment template.

  - id: "review"
    agent: "canon-reviewer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - review_code
      - log_step
    artifacts:
      - "plans/${slug}/REVIEW.md"
      - "reviews/"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Review all code for Canon principle compliance. Save review to
      workspace. Verdicts: clean/warning (done), blocking (present to user).
```

#### 3. `explore.yaml`

Read `flows/explore.md`. States: `research` (parallel, canon-researcher, roles: [codebase, dependencies?]), `synthesize` (single, canon-architect as analyst), `done` (terminal).

```yaml
name: "explore"
description: "Research and report on a codebase question — no implementation"
tier: "small"

steps:
  - id: "research"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "research/codebase.md"
      - "research/dependencies.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Parallel research — spawn two subagents:
      1. codebase role: how the system works today (architecture, data flow,
         key abstractions, entry points)
      2. dependencies role (optional): external dependencies, integration
         points, configuration, constraints
      If the question doesn't involve external dependencies, skip the
      dependencies role. Each saves to research/{role}.md.

  - id: "synthesize"
    agent: "canon-architect"
    dispatch: "subagent"
    mcp_tools:
      - graph_query
      - log_step
    artifacts:
      - "plans/${slug}/ANALYSIS.md"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Synthesize research findings into an actionable analysis. Read all
      research from workspace research/ directory. Produce a clear report
      answering the original question. Include architecture diagrams (text),
      key findings, risks, and recommended next steps.
```

### Canon principles to apply
- **agent-plans-are-prompts**: Each step's `notes` field must contain actionable guidance specific to this flow, not generic restatements of agent definitions.

### Tests to write
- No code tests. YAML validation only for all three files.

### Verify
1. All three files exist at `skills/canon/runbooks/{review-only,security-audit,explore}.yaml`
2. All three parse as valid YAML
3. Steps cover all states from their respective `flows/*.md` files
4. `review-only.yaml`: 1 step (review)
5. `security-audit.yaml`: 2 steps (security, review)
6. `explore.yaml`: 2 steps (research with parallel note, synthesize)
7. `npm run build` passes
8. `npm test` passes

### Done when
- All three runbooks exist and parse as valid YAML
- Each runbook's steps map 1:1 to the legacy flow states (terminal states are implicit — not runbook steps)
- `notes` fields carry the essential spawn context from legacy spawn instructions
- Build and tests pass unchanged
