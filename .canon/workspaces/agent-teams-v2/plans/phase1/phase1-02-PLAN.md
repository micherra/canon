---
task_id: "phase1-02"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/review-only.yaml
  - skills/canon/runbooks/security-audit.yaml
  - skills/canon/runbooks/explore.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create simple runbooks (review-only, security-audit, explore)

### Action

Create three simple runbooks that have 1-3 steps each. These are the simplest flows after fast-path.

#### 1. `skills/canon/runbooks/review-only.yaml`

```yaml
name: review-only
description: "Review current changes against Canon principles"
tier: review

steps:
  - id: review
    agent: canon-reviewer
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - get_drift_report
    artifacts:
      - "${WORKSPACE}/plans/${slug}/REVIEW.md"
      - "${WORKSPACE}/reviews/"
    hitl: on_failure
    notes: >
      Spawn canon-reviewer with the diff (git diff base..HEAD or PR diff),
      matched principles (full body), and file context. The reviewer produces
      a four-stage review. If verdict is BLOCKING, present to user. If CLEAN
      or WARNING, flow completes.
      For large diffs (300+ lines), consider fan-out: cluster files by layer,
      spawn parallel reviewer subagents scoped to each cluster, then aggregate
      verdicts.
```

#### 2. `skills/canon/runbooks/security-audit.yaml`

```yaml
name: security-audit
description: "Security scan followed by principle compliance review"
tier: security

steps:
  - id: security
    agent: canon-security
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/SECURITY.md"
    hitl: on_failure
    notes: >
      Spawn canon-security to scan for vulnerabilities. If critical findings,
      present to user for resolution before proceeding to review.

  - id: review
    agent: canon-reviewer
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - get_drift_report
    artifacts:
      - "${WORKSPACE}/plans/${slug}/REVIEW.md"
      - "${WORKSPACE}/reviews/"
    hitl: on_failure
    notes: >
      Spawn canon-reviewer for principle compliance review. Same as review-only
      but runs after security scan. If verdict is BLOCKING, present to user.
```

#### 3. `skills/canon/runbooks/explore.yaml`

```yaml
name: explore
description: "Research and report on a codebase question -- no implementation"
tier: research

steps:
  - id: research
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
    artifacts:
      - "${WORKSPACE}/research/codebase.md"
      - "${WORKSPACE}/research/dependencies.md"
    hitl: none
    notes: >
      Spawn parallel canon-researcher subagents: one for codebase research,
      one (optional) for dependencies research. Each produces a research finding.
      The dependencies researcher is optional -- skip if the question does not
      involve external dependencies.

  - id: synthesize
    agent: canon-architect
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/plans/${slug}/ANALYSIS.md"
    hitl: none
    notes: >
      Spawn canon-architect (in analysis role) to synthesize research findings
      into an actionable analysis report. Inject all research findings from the
      previous step. The architect produces a clear answer to the user's question
      with architecture diagrams, key findings, and recommended next steps.
```

**Verify flow coverage**: Compare each runbook against its legacy flow:
- `review-only.md`: states review, done. Runbook covers review.
- `security-audit.md`: states security (from fragment), review, done. Runbook covers security, review.
- `explore.md`: states research (parallel), synthesize, done. Runbook covers research, synthesize.

### Canon principles to apply

- **simplicity-first**: These are the simplest flows. Keep runbooks minimal -- 1-3 steps each.
- **information-hiding**: Each step is self-contained with its own MCP tools and artifacts.

### Tests to write

No tests -- these are YAML playbook files with no runtime behavior.

### Verify

1. All three files exist at `skills/canon/runbooks/{review-only,security-audit,explore}.yaml`
2. Each file parses as valid YAML
3. Step IDs match legacy flow states
4. `npm run build` and `npm test` still pass

### Done when

- Three runbook files exist and are valid YAML
- All states from their legacy flows are represented
- Files follow the runbook YAML structure from the design document
