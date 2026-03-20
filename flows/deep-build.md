---
name: deep-build
description: Full pipeline — research, design, wave implementation, test, security, review with convergence
tier: large
progress: ${WORKSPACE}/progress.md

states:
  research:
    type: parallel
    agents: [canon-researcher]
    roles: [codebase, architecture, risk]
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
      done: implement
      has_questions: hitl

  implement:
    type: wave
    agent: canon-implementor
    template: implementation-log
    gate: test-suite
    transitions:
      done: context-sync
      blocked: hitl

  context-sync:
    type: single
    agent: canon-scribe
    template: context-sync-report
    skip_when: no_contract_changes
    transitions:
      updated: test
      no_updates: test
      blocked: hitl

  test:
    type: single
    agent: canon-tester
    template: test-report
    max_iterations: 2
    stuck_when: same_file_test
    transitions:
      all_passing: security
      implementation_issue: fix-impl
      blocked: hitl

  fix-impl:
    type: single
    agent: canon-implementor
    role: fix
    template: implementation-log
    transitions:
      done: context-sync-fix
      blocked: hitl

  context-sync-fix:
    type: single
    agent: canon-scribe
    template: context-sync-report
    skip_when: no_contract_changes
    transitions:
      updated: test
      no_updates: test
      blocked: hitl

  security:
    type: single
    agent: canon-security
    template: security-assessment
    transitions:
      done: review
      critical: fix-security
      blocked: hitl

  fix-security:
    type: parallel-per
    agent: canon-refactorer
    iterate_on: security_findings
    max_iterations: 2
    stuck_when: same_violations
    transitions:
      done: security
      cannot_fix: hitl
      blocked: hitl

  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    large_diff_threshold: 500
    transitions:
      clean: done
      warning: done
      blocking: fix-violations
      blocked: hitl

  fix-violations:
    type: parallel-per
    agent: canon-refactorer
    iterate_on: violation_groups
    max_iterations: 3
    stuck_when: same_violations
    transitions:
      done: review
      cannot_fix: hitl

  done:
    type: terminal
---

## Spawn Instructions

### research
Research ${role} patterns relevant to: ${task}. Save to ${WORKSPACE}/research/${role}.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

### design
Design the technical approach for: ${task}. Read research from ${WORKSPACE}/research/ (especially risk.md). Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Save task plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to INDEX.md. Record decisions to ${WORKSPACE}/decisions/. Templates: design-decision, session-context at ${CLAUDE_PLUGIN_ROOT}/templates/. Initialize ${WORKSPACE}/context.md.

### implement
Execute task plan at ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}

### context-sync
Sync docs after implementation. Diff source: implementation commits. Summaries: ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md.

### context-sync-fix
Sync docs after fix-impl. Diff source: fix commits. Summary: ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC-FIX.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md.

### test
Write integration tests and fill coverage gaps. Start with Coverage Notes from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md.

### fix-impl
Fix failures from ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Determine source bugs vs test bugs for each failure. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

### security
Scan implemented code for vulnerabilities. File list from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.

### review
Review changes via `git diff ${base_commit}..HEAD` (scoped to file list if provided). After Stages 1-2, cross-check against ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.

### fix-security
Fix security finding: ${item.severity} — ${item.detail} in ${item.file_path}. Preserve behavior, verify with tests.

### fix-violations
Fix violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}.
