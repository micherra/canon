---
name: fast-path
description: Single-agent fast path — implement, test, and self-review in one pass
tier: small
entry: execute
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: pre-launch-check
    with:
      after_passing: ship

  - fragment: ship-done

states:
  execute:
    type: single
    agent: engineer
    template: implementation-log
    max_iterations: 1
    stuck_when: same_status
    inject_context:
      - from: file_context
        as: file_context
    transitions:
      done: pre-launch-check
      done_with_concerns: pre-launch-check
      blocked: hitl
---

## Spawn Instructions

### execute
FAST PATH — single-agent mode. Task: ${task}. You are the implementor: implement the change (TDD), verify all tests pass, self-review against Canon principles, and commit. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md. Your summary MUST include a `### Self-Review` section with Canon principle compliance declarations and a `### Verification` section confirming all tests pass.

${progress}
