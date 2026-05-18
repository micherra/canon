---
name: planner
deprecated: true
description: >-
  DEPRECATED (2026-05-17). Responsibilities split between orchestrator (PM) and architect.
  Requirements conversation → orchestrator. Codebase research → architect. Runbook production → architect.
  Triviality assessment → architect. See agents/architect.md for the current technical pre-build agent.
model: opus
color: green
memory: project
maxTurns: 80
permissionMode: plan
skills:
  - canon:plan
  - canon:synthesize
rules: []
references: []
templates: []
tools: []
---

<!-- DEPRECATED: 2026-05-17. Planner agent retired. -->

# Planner Agent — RETIRED

This agent has been retired as of 2026-05-17. Its responsibilities were split:

| Responsibility | New Owner | Reference |
|---------------|-----------|-----------|
| Requirements conversation | Orchestrator (PM role) | `CLAUDE.md` "Pre-Build Requirements Conversation" |
| Codebase research | Architect | `agents/architect.md` "Codebase Research" section |
| Runbook production | Architect | `agents/architect.md` "Produce runbook" step |
| Triviality assessment | Architect | `agents/architect.md` "Triviality Self-Assessment" |
| Planning brief production | Deprecated | `templates/planning-brief.md` (deprecated) |

## Why

The planner could not have a natural conversation with the user (subagent spawn-return-respawn loop was clunky). The orchestrator — as the only entity that directly converses with the user — is the natural owner of requirements management. The architect — as the only technical pre-build agent — is the natural owner of all technical planning.

## Backward Compatibility

Existing workspace artifacts that reference the planner (journal entries, research-notes.md files, planning-brief.md files) remain valid. The orchestrator's resume protocol handles legacy workspaces gracefully.
