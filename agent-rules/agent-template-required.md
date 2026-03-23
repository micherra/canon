---
id: agent-template-required
title: Template Usage Is Mandatory
severity: rule
tags: [agent-behavior, workspace, quality]
---

When the orchestrator provides a template path, the agent **must** use it. Templates are not optional fallbacks — they are the required output format.

## Rule

1. **Read the template first** — before producing any output, read the template file at the path provided by the orchestrator.
2. **Follow the structure exactly** — use the template's sections, frontmatter fields, and formatting. Do not invent your own structure.
3. **If the template path is missing or unreadable** — report `NEEDS_CONTEXT` to the orchestrator with the message: "Template path not provided or unreadable: {path}". Do NOT fall back to a default format silently.
4. **If the template doesn't fit your output** — this means either the template is wrong or your output is wrong. Report `NEEDS_CONTEXT` and explain the mismatch. Do NOT skip the template.

## Why

Templates exist so downstream agents can reliably parse upstream output. When an implementor skips the implementation-log template, the tester can't find the `### Tests Written` section. When a researcher skips the research-finding template, the architect gets unparseable findings. Consistency across the team is more valuable than any individual agent's formatting preference.

## Which Templates

| Agent | Template | Path |
|-------|----------|------|
| canon-researcher | research-finding | `${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md` |
| canon-architect | design-decision | `${CLAUDE_PLUGIN_ROOT}/templates/design-decision.md` |
| canon-architect | session-context | `${CLAUDE_PLUGIN_ROOT}/templates/session-context.md` |
| canon-implementor | implementation-log | `${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md` |
| canon-tester | test-report | `${CLAUDE_PLUGIN_ROOT}/templates/test-report.md` |
| canon-reviewer | review-checklist | `${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md` |
| canon-security | security-assessment | `${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md` |
| canon-scribe | context-sync-report | `${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md` |

The orchestrator is responsible for passing these paths. Agents are responsible for using them.

## Exceptions

**canon-fixer (violation-fix mode)**: The fixer in violation-fix mode produces a structured status report (FIXED/PARTIAL_FIX/CANNOT_FIX with commit hash, change description, and behavior preservation confirmation) rather than a full artifact document. Its output is consumed only by the orchestrator for transition decisions, not parsed by downstream agents. The fixer in violation-fix mode is exempt from template requirements — no template is defined for it in the flow states, and it should NOT report NEEDS_CONTEXT for a missing template.

