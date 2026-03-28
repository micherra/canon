---
name: migrate
description: Staged migration with rollback planning and verification at each stage
tier: medium
entry: research
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: user-checkpoint
    with:
      after_approved: implement
      on_revise: design

  - fragment: verify-fix-loop
    with:
      after_all_passing: security
      role: migration-verify

  - fragment: security-scan
    with:
      after_done: context-sync
      on_critical: fix-security

  - fragment: context-sync
    with:
      next: review

  - fragment: review-fix-loop
    with:
      after_clean: ship
      after_warning: ship
      max_iterations: 2

  - fragment: ship-done

states:
  research:
    type: parallel
    agents: [canon-researcher]
    roles: [migration-scope, rollback-plan]
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
        section: rollback-plan
        as: rollback_findings
    transitions:
      done: checkpoint
      has_questions: hitl

  implement:
    type: wave
    agent: canon-implementor
    template: implementation-log
    transitions:
      done: verify
      blocked: hitl
---

## Spawn Instructions

### research
Research ${role} for migration: ${task}.

For migration-scope role: identify all files, configs, schemas, and dependencies affected. Map the current state and target state. Check for data that needs transformation. Save to ${WORKSPACE}/research/migration-scope.md.

For rollback-plan role: determine rollback strategy — can changes be reverted cleanly? Are there data migrations that are destructive? What's the safe rollback point? Save to ${WORKSPACE}/research/rollback-plan.md.

Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

### design
Design staged migration plan for: ${task}. Read research from ${WORKSPACE}/research/. Key constraint: each wave must leave the system in a working state. If the migration involves data, design forward-compatible steps (old code works with new schema where possible). Include rollback instructions per stage. Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Save task plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to INDEX.md. Record decisions to ${WORKSPACE}/decisions/. Templates: design-decision, session-context at ${CLAUDE_PLUGIN_ROOT}/templates/. Initialize ${WORKSPACE}/context.md.

### implement
Execute migration stage from ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Verify the system works after this stage — run tests, check for regressions. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}

### verify
Verify migration correctness. Run full test suite plus migration-specific checks: data integrity, schema compatibility, backward compatibility where required. Check ${WORKSPACE}/plans/${slug}/*-SUMMARY.md for what changed. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md.

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Fix migration issues — pay special attention to data integrity and backward compatibility. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}

### security
Scan migration for security issues — especially credential handling, connection strings, data exposure during migration, and permission changes. File list from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.
