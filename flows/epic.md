---
name: epic
description: Adaptive epic pipeline — research, design, collaborative wave implementation with replan, test, security, review
tier: large
entry: research
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: user-checkpoint
    with:
      after_approved: implement
      on_revise: design

  - fragment: context-sync
    with:
      next: test

  - fragment: plan-review
  - fragment: pattern-check
  - fragment: early-scan
  - fragment: impl-handoff
  - fragment: targeted-research

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
    max_iterations: 10
    stuck_when: no_gate_progress
    consultations:
      before: [plan-review]
      between: [pattern-check, early-scan, targeted-research]
      after: [impl-handoff]
    transitions:
      done: context-sync
      epic_complete: ship
      blocked: hitl
---

## Spawn Instructions

### research
Research ${role} patterns relevant to: ${task}. Save to ${WORKSPACE}/research/${role}.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

### design
Design the technical approach for: ${task}. Read research from ${WORKSPACE}/research/ (especially risk.md). Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Save task plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to INDEX.md. Record decisions to ${WORKSPACE}/decisions/. Templates: design-decision, session-context at ${CLAUDE_PLUGIN_ROOT}/templates/. Initialize ${WORKSPACE}/context.md.

Use the North Star template section in the design document. Include machine-readable done criteria in the DESIGN.md frontmatter.

After producing plans, write affected files to board metadata: call `update_board({ workspace: "${WORKSPACE}", action: "set_metadata", metadata: { affected_files: "<JSON array of all files from task plans>" } })`. The value must be a JSON-stringified array of file path strings (e.g., `'["src/foo.ts","src/bar.ts"]'`).

### implement
Execute task plan at ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}

${enrichment}

### security
Scan implemented code for vulnerabilities. File list from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.

### fix-security
Mode: violation-fix. Security finding: ${item.severity} — ${item.detail} in ${item.file_path}. Preserve behavior, verify with tests.
