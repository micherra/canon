---
fragment: context-sync
description: Sync documentation after implementation or fix changes
entry: context-sync
params:
  next: ~

states:
  context-sync:
    type: single
    agent: canon-scribe
    template: context-sync-report
    skip_when: no_contract_changes
    transitions:
      updated: ${next}
      no_updates: ${next}
      blocked: hitl
---

## Spawn Instructions

### context-sync
Sync docs after implementation. Diff source: commits since last context-sync or build start. Summaries: ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md.
