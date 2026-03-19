---
name: quick-fix
description: Implement and review — fast path for small changes
tier: small

states:
  implement:
    type: single
    agent: canon-implementor
    template: implementation-log
    transitions:
      done: context-sync
      blocked: hitl

  context-sync:
    type: single
    agent: canon-scribe
    transitions:
      updated: review
      no_updates: review

  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    transitions:
      clean: done
      warning: done
      blocking: fix-violations

  fix-violations:
    type: parallel-per
    agent: canon-refactorer
    iterate_on: violation_groups
    max_iterations: 2
    stuck_when: same_violations
    transitions:
      done: review
      cannot_fix: hitl

  done:
    type: terminal
---

## Spawn Instructions

### implement
Implement the following task: ${task}. Load principles via the get_principles MCP tool with summary_only: true for each file you modify. Read project conventions at .canon/CONVENTIONS.md if it exists. Read CLAUDE.md. Commit atomically. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md using the implementation-log template at ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### context-sync
Sync project documentation after implementation. Read the git diff from the implementation commit. Read ${WORKSPACE}/plans/${slug}/SUMMARY.md. Read current CLAUDE.md and .canon/CONVENTIONS.md. Classify changes as contract/structure/dependency/invariant/internal/test-only. Update docs for contract-level changes only. Use the claudemd-template at ${CLAUDE_PLUGIN_ROOT}/templates/claudemd-template.md for CLAUDE.md structure. Save sync report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### review
Review all code changes from this build. Use git diff to see changes. Save review to ${WORKSPACE}/plans/${slug}/REVIEW.md using the review-checklist template at ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md. Also save a copy to ${WORKSPACE}/reviews/. Append a log entry to ${WORKSPACE}/log.jsonl.

### fix-violations
Fix the Canon principle violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}. Load the violated principle in full. Refactor to comply while preserving behavior. Commit atomically.
