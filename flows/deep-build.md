---
name: deep-build
description: Full pipeline — research, design, wave implementation, test, security, review with convergence
tier: large
entry: research
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: context-sync
    with:
      next: test

  - fragment: user-checkpoint
    with:
      after_approved: implement
      on_revise: design

  - fragment: plan-review
  - fragment: pattern-check
  - fragment: early-scan
  - fragment: impl-handoff

  - fragment: test-fix-loop
    with:
      after_all_passing: security

  - fragment: security-scan
    with:
      after_done: review
      on_critical: fix-security

  - fragment: review-fix-loop
    with:
      after_clean: ship
      after_warning: ship
    overrides:
      review:
        large_diff_threshold: 500

  - fragment: ship-done

states:
  research:
    type: parallel
    agents: [canon-researcher]
    roles: [codebase, risk]
    template: research-finding
    transitions:
      done: design
      blocked: hitl

  design:
    type: single
    agent: canon-architect
    template: [design-decision, session-context]
    inject_context:
      - from: research
        section: risk
        as: risk_findings
    transitions:
      done: checkpoint
      has_questions: hitl

  implement:
    type: wave
    agent: canon-implementor
    template: implementation-log
    gate: test-suite
    consultations:
      before: [plan-review]
      between: [pattern-check, early-scan]
      after: [impl-handoff]
    transitions:
      done: context-sync
      blocked: hitl
---

## Spawn Instructions

### research
Research ${role} patterns relevant to: ${task}. Save to ${WORKSPACE}/research/${role}.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

### design
Design the technical approach for: ${task}. Read research from ${WORKSPACE}/research/ (especially risk.md). Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Save task plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to INDEX.md. Record decisions to ${WORKSPACE}/decisions/. Templates: design-decision, session-context at ${CLAUDE_PLUGIN_ROOT}/templates/. Initialize ${WORKSPACE}/context.md.

### implement
Execute task plan at ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}

### security
Scan implemented code for vulnerabilities. File list from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.

### fix-security
Mode: violation-fix. Security finding: ${item.severity} — ${item.detail} in ${item.file_path}. Preserve behavior, verify with tests.
