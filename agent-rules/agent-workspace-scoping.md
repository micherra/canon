---
id: agent-workspace-scoping
title: Workspace Scoping
severity: rule
tags: [agent-behavior, workspace, context-sharing]
---

Agents operate within a **branch-scoped workspace** at `.canon/workspaces/{branch}/`. Each agent has defined read and write permissions — respect them strictly.

## Workspace Structure

```
.canon/workspaces/{sanitized-branch}/
├── session.json              # Session metadata
├── log.jsonl                 # Chronological agent activity log
├── context.md                # Living shared context document
├── research/                 # Research findings
├── decisions/                # Design decisions with rationale
├── plans/                    # Task plans and build artifacts
│   └── {task-slug}/
│       ├── DESIGN.md
│       ├── INDEX.md
│       ├── CONVENTIONS.md
│       ├── *-PLAN.md
│       ├── *-SUMMARY.md
│       ├── REVIEW.md
│       ├── TEST-REPORT.md
│       └── SECURITY.md
├── reviews/                  # Review outputs
└── notes/                    # Freeform notes from agents or users
```

## Branch Name Sanitization

Branch names are sanitized for use as folder names:
- Replace `/` with `--`
- Replace spaces with `-`
- Strip characters that aren't alphanumeric or `-`
- Lowercase everything
- Truncate to 80 characters

Example: `feature/add-auth` becomes `feature--add-auth`

## Agent Permissions

| Agent | Read | Write |
|-------|------|-------|
| **researcher** | templates/, session.json | research/, log.jsonl |
| **architect** | research/, templates/, session.json, context.md | decisions/, plans/, log.jsonl, context.md |
| **implementor** | plans/{slug}/{task}-PLAN.md, context.md, decisions/ | plans/{slug}/{task}-SUMMARY.md, log.jsonl |
| **tester** | plans/{slug}/*-SUMMARY.md, context.md | plans/{slug}/TEST-REPORT.md, log.jsonl |
| **security** | plans/{slug}/*-SUMMARY.md | plans/{slug}/SECURITY.md, log.jsonl |
| **reviewer** | plans/{slug}/*-SUMMARY.md (post-Stage-2 cross-check only) | reviews/, log.jsonl |
| **refactorer** | reviews/, decisions/, context.md | log.jsonl |
| **learner** | everything in workspace | notes/, log.jsonl |
| **writer** | everything in workspace | notes/ |

Key constraints:
- **Reviewer never reads research or plans** — cold review principle is preserved
- **Implementor only reads its own plan + referenced decisions** — fresh context principle is preserved
- **Researcher never reads other researchers** — scoped research principle is preserved
- **All agents append to log.jsonl** — shared activity trail

## Log Entry Format

Every agent appends a JSON line to `log.jsonl` when starting or completing work:

```json
{"timestamp": "ISO-8601", "agent": "canon-researcher", "action": "start", "detail": "Codebase research for order-creation"}
{"timestamp": "ISO-8601", "agent": "canon-researcher", "action": "complete", "detail": "Found 3 relevant patterns", "artifacts": ["research/codebase.md"]}
```

## Session Metadata

`session.json` is created by the orchestrator at workspace initialization:

```json
{
  "branch": "feature/add-auth",
  "sanitized": "feature--add-auth",
  "created": "ISO-8601",
  "task": "Add authentication to API endpoints",
  "tier": "medium",
  "status": "active"
}
```

## When to Write

Agents write to the workspace **when they produce artifacts that other agents or users would benefit from**. This is not forced — if an agent's output is ephemeral or only relevant to the orchestrator, it doesn't need to be persisted. But anything that provides context, rationale, or findings should be written using the appropriate template.
