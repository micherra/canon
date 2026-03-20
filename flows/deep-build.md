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
Research the existing ${role} patterns relevant to: ${task}. Use the research-finding template at ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md. Save findings to ${WORKSPACE}/research/${role}.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### design
Design the technical approach for: ${task}. Read research findings from ${WORKSPACE}/research/. Pay special attention to risk findings at ${WORKSPACE}/research/risk.md. Load relevant Canon principles. Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Break the design into atomic task plans — save plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to ${WORKSPACE}/plans/${slug}/INDEX.md. Record design decisions to ${WORKSPACE}/decisions/ using the design-decision template at ${CLAUDE_PLUGIN_ROOT}/templates/design-decision.md. Initialize ${WORKSPACE}/context.md using the session-context template at ${CLAUDE_PLUGIN_ROOT}/templates/session-context.md. Append log entries to ${WORKSPACE}/log.jsonl.

### implement
Execute the task plan at ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Load principles via the get_principles MCP tool with summary_only: true for each file you modify. Read project conventions at .canon/CONVENTIONS.md if it exists. Read task conventions at ${WORKSPACE}/plans/${slug}/CONVENTIONS.md if it exists. Read shared context at ${WORKSPACE}/context.md if it exists. Read referenced decisions from ${WORKSPACE}/decisions/ as listed in your plan's decisions: frontmatter. Read CLAUDE.md. Commit atomically. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md using the implementation-log template at ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### context-sync
Sync project documentation after implementation. Read the git diff from the implementation commits. Read implementor summaries from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Read current CLAUDE.md, ${WORKSPACE}/context.md, and .canon/CONVENTIONS.md. Classify changes as contract/structure/dependency/invariant/internal/test-only. Update docs for contract-level changes only. Use the claudemd-template at ${CLAUDE_PLUGIN_ROOT}/templates/claudemd-template.md for CLAUDE.md structure. Save sync report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md using the context-sync-report template at ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### context-sync-fix
Sync project documentation after fix-impl. Read the git diff from the fix commits. Read ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Read current CLAUDE.md, ${WORKSPACE}/context.md, and .canon/CONVENTIONS.md. Classify changes and update docs for contract-level changes only. Use the claudemd-template at ${CLAUDE_PLUGIN_ROOT}/templates/claudemd-template.md for CLAUDE.md structure. Save sync report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC-FIX.md using the context-sync-report template at ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### test
Write integration tests and fill coverage gaps. Implementors already wrote unit tests — focus on cross-task integration and missed coverage. Load principles via the get_principles MCP tool with summary_only: true. Read task summaries from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md — start with the Coverage Notes section. Read implementor test files. Run the full test suite. Save test report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md using the test-report template at ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### fix-impl
Fix the failing tests reported in ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Read the ### Issues Found table for the specific files, failing tests, root causes, and suggested fixes. Read each failing test file to understand expected behavior. Fix the source files to make failing tests pass without breaking other tests. Run the test suite to verify. Commit atomically. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md using the implementation-log template at ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### security
Scan implemented code for security vulnerabilities. Read task summaries from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md for file list. Save assessment to ${WORKSPACE}/plans/${slug}/SECURITY.md using the security-assessment template at ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### review
Review all code changes from this build. Use `git diff ${base_commit}..HEAD` to see all changes (base_commit is the pre-build state). After completing your independent Stage 1 and Stage 2 review, perform the Stage 3 compliance cross-check by reading implementor summaries from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save review to ${WORKSPACE}/plans/${slug}/REVIEW.md using the review-checklist template at ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md. Also save a copy to ${WORKSPACE}/reviews/. Append a log entry to ${WORKSPACE}/log.jsonl.

### fix-security
Fix the critical security finding: ${item.severity} — ${item.detail} in ${item.file_path}. Load the relevant security principles in full. Fix the vulnerability while preserving behavior. Run any existing tests to verify no regressions. Commit atomically.

### fix-violations
Fix the Canon principle violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}. Load the violated principle in full. Refactor to comply while preserving behavior. Commit atomically.
