---
runbook: nf-10-coverage-map-generalization
flow: fast-path
tier: fast-path
created: 2026-04-28T00:00:00Z
iteration: 2
confidence_signals:
  - dimension: scope
    level: medium
    rationale: >-
      Iteration 1 identified four target files based on known handoff points. Research step
      will audit the full template landscape to confirm no additional handoff boundaries need
      coverage maps, and check doc/template alignment. Scope may expand based on findings.
  - dimension: step-sequence
    level: high
    rationale: >-
      Research before implement ensures the implement step has complete scope. The rest of
      the sequence (review, context-sync, learn) is unchanged.
  - dimension: contract-pairings
    level: high
    rationale: >-
      Templates are consumed by agents via agent-template-required; no programmatic consumers
      parse these sections. Research step will verify producer/consumer relationships.
status: draft
---

# Runbook: NF-10 Coverage Map Generalization (iteration 2)

## Overview

This is a fast-path instruction-layer change that extends the NF-8 coverage map pattern to additional handoff points. Iteration 1 identified four markdown files (two templates, two agent definitions) but skipped research. Iteration 2 adds a research step before implement to audit the full template landscape, cross-reference agent producer/consumer relationships, and check documentation consistency. The research findings will confirm or expand the implement step's scope.

## Steps

### Step 1: research

```yaml
id: research
agent: researcher
dispatch: subagent
skills: []
cause: >-
  User flagged iteration 1 had insufficient research. Templates should always be aligned
  to docs. Need to audit the full template landscape before implementing.
mcp_tools:
  - get_file_context
  - graph_query
  - semantic_search
artifacts:
  - ${WORKSPACE}/plans/${slug}/research-findings.md
hitl: checkpoint
skip_when: ~
```

**Intent:** Audit the full template and agent landscape to ensure the implement step has complete scope. Three research dimensions:

1. **Template audit**: Read every template in `templates/` and identify each handoff boundary (where one agent's output becomes another agent's input). For each boundary, assess whether a coverage map exists, is needed, or is not applicable. The known candidates are `task-plan.md` (architect -> engineer) and `implementation-log.md` (engineer -> reviewer), but the audit must confirm no others are missed -- particularly `design-document.md`, `plan-index.md`, `wave-briefing.md`, `wave-report.md`, `research-finding.md`, and `context-sync-report.md`.

2. **Agent cross-reference**: Read agent definitions in `agents/` and map which agents produce which templates (`used-by` frontmatter) and which agents consume them (`read-by` frontmatter). Verify that every producer/consumer pair with a scope-narrowing risk has been identified.

3. **Documentation check**: Search `docs/` and `references/` for any existing documentation of the coverage map pattern. If the pattern is documented (e.g., in a reference doc or CLAUDE.md), note whether those docs need updating to reflect the generalized pattern. If the pattern is undocumented, note that as well -- the scribe's context-sync step may need to create documentation.

**Coordination notes:** Produces `research-findings.md`. The orchestrator reviews findings at the HITL checkpoint. If the research reveals additional templates or handoff points needing coverage maps, the orchestrator updates the implement step's scope before proceeding. If findings confirm the original four-file scope, implement proceeds as-is.

---

### Step 2: implement

```yaml
id: implement
agent: engineer
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/plans/${slug}/SUMMARY.md
hitl: none
skip_when: ~
```

**Intent:** Apply the coverage map pattern to all identified files. The baseline scope (from iteration 1) is four files; research findings may expand this.

Baseline edits:
- For `templates/task-plan.md`: add a "Brief Coverage" section after the "Done when" section with a table mapping each runbook requirement to a task element or explicit out-of-scope rationale.
- For `templates/implementation-log.md`: add a "Criteria Coverage" section after "Risk Mitigation Tests" (within Coverage Notes) with a table mapping each task plan acceptance criterion to what was implemented or explicit deferral rationale.
- For `agents/architect.md`: add instructions in Step 7 (break into atomic task plans) requiring the architect to populate the Brief Coverage section.
- For `agents/engineer.md`: add instructions in Step 10 (produce summary) requiring the engineer to populate the Criteria Coverage section.

Both tables use the identical disposition vocabulary: `covered | descoped | partial`.

If research findings identified additional files, apply the same pattern to those files as well, following the researcher's recommendations for placement and table structure.

**Coordination notes:** Produces SUMMARY.md. The reviewer consumes the diff in the next step. The engineer should reference research-findings.md for any scope expansions beyond the baseline four files.

---

### Step 3: review

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

**Intent:** Verify all file edits are structurally consistent with the NF-8 coverage map pattern in `templates/planning-brief.md`. Check that disposition vocabulary matches (`covered | descoped | partial`), table columns are consistent, and agent instructions reference the correct template sections. If research expanded scope beyond the original four files, verify those additions follow the same pattern. Cold review -- the reviewer evaluates the diff on its own merits.

**Coordination notes:** Produces REVIEW.md. If verdict is BLOCKING, the orchestrator spawns engineer in fix mode. If CLEAN or WARNING, flow proceeds to mandatory tail.

---

## Mandatory Tail

### Step 4: context-sync

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

**Intent:** The scribe updates CLAUDE.md, context.md, and CONVENTIONS.md to reflect the new coverage map sections in the template and agent files. If the research step identified documentation gaps (e.g., the coverage map pattern is undocumented in references/), the scribe should address those as well.

**Coordination notes:** Runs after review completes. Produces `context-sync-report.md`. The `learn` step follows immediately.

---

### Step 5: learn

```yaml
id: learn
agent: learner
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/learning.md
hitl: none
skip_when: ~
```

**Intent:** The learner analyzes the completed flow for patterns -- specifically whether the NF-8 coverage map generalization pattern suggests a broader principle about structured traceability at handoff boundaries.

**Coordination notes:** Final step. Produces `learning.md`. No subsequent steps; orchestrator transitions to `complete_flow` after this step.
