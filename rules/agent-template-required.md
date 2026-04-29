---
id: agent-template-required
title: Template Usage Is Mandatory
severity: rule
tags: [agent-behavior, workspace, quality]
---

When an agent declares templates in its `templates:` frontmatter field, each listed template defines the required output shape. Templates are not optional fallbacks — they are the contract downstream agents parse against.

## Rule

1. **Preloaded templates set the output shape** — every entry in the agent's `templates:` frontmatter is loaded into the spawn prompt verbatim by `resolve_agent_skills`. The agent's output must match the structure (sections, frontmatter fields, required blocks) of whichever preloaded template applies to the step it is producing.
2. **Do not invent structure** — use the template's sections, frontmatter fields, and formatting. Optional evidence blocks (e.g., `External Evidence`, security finding evidence fields) are part of the contract when they appear in the template.
3. **If no template is preloaded for the output you need** — your `templates:` declaration is wrong or the orchestrator has spawned you for a step you cannot execute. Report `NEEDS_CONTEXT` with the message: "No preloaded template for expected output: {artifact description}". Do NOT fall back to an ad-hoc format.
4. **If the preloaded template doesn't fit your output** — this means either the template is wrong or your output is wrong. Report `NEEDS_CONTEXT` and explain the mismatch. Do NOT skip the template.

## Why

Templates exist so downstream agents can reliably parse upstream output. When an engineer skips the implementation-log template, the tester can't find the `### Tests Written` section. Consistency across the team is more valuable than any individual agent's formatting preference.

Preloading these templates into the spawn prompt (phase1-08.6) replaces the earlier pattern of "orchestrator provides a template path, agent reads it first." Preloaded means the agent already has the template content at turn zero — no Read call, no path to pass, no forgetting. The agent is responsible for producing output matching the preloaded shape.

## Which Templates Apply Per Agent

Each agent's `templates:` frontmatter lists the specific templates it produces. As of Gate A:

| Agent | templates: |
|-------|-----------|
| architect | design-document, task-plan, design-decision, session-context |
| engineer | implementation-log |
| planner | planning-brief, runbook |
| reviewer | review-checklist |
| scribe | claudemd-template, context-sync-report |
| security | security-assessment |
| shipper | pr-description |
| tester | test-report |

The resolver confirms every declared template resolves at boot time (integration test); missing declarations fail CI.

## Exceptions

**engineer (fix mode)**: The engineer in fix mode produces a structured status report (FIXED / PARTIAL_FIX / CANNOT_FIX with commit hash, change description, and behavior preservation confirmation) rather than a full artifact document. Its output is consumed only by the orchestrator for transition decisions, not parsed by downstream agents. The engineer in fix mode is exempt from the implementation-log template requirement — no `NEEDS_CONTEXT` report for the missing shape.
