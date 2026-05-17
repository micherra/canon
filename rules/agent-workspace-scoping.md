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
├── .lock                     # Build lock — prevents concurrent builds on same branch
├── board.json                # Flow execution state (states, transitions, iterations)
├── board.json.bak            # Board backup — previous valid state for crash recovery
├── progress.md               # Append-only learnings across iterations
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
└── reviews/                  # Review outputs
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
| **intake** | board.json (read-only for status) | — (no workspace writes; spawns orchestrator) |
| **orchestrator** | board.json, flow templates | board.json, progress.md |
| **planner** | templates/ | plans/{slug}/research-notes.md |
| **architect** | plans/{slug}/research-notes.md, research/ (legacy), templates/, context.md | decisions/, plans/, context.md |
| **implementor** | plans/{slug}/{task}-PLAN.md, context.md, decisions/ | plans/{slug}/{task}-SUMMARY.md |
| **tester** | plans/{slug}/*-SUMMARY.md, context.md | plans/{slug}/TEST-REPORT.md |
| **security** | plans/{slug}/*-SUMMARY.md | plans/{slug}/SECURITY.md |
| **reviewer** | plans/{slug}/*-SUMMARY.md (post-Stage-2 cross-check only) | plans/{slug}/REVIEW.md, reviews/ |
| **scribe** | plans/{slug}/*-SUMMARY.md, CLAUDE.md, context.md, .canon/CONVENTIONS.md | plans/{slug}/CONTEXT-SYNC.md, CLAUDE.md, context.md, .canon/CONVENTIONS.md |
| **refactorer** | reviews/, decisions/, context.md | — |
| **learner** | everything in workspace | — |
| **writer** | everything in workspace | — |

Key constraints:
- **Build lock**: `.lock` prevents concurrent builds. Stale locks (>2 hours) are auto-removed.
- **Board backup**: `board.json.bak` written before every update for crash recovery.
- Only the orchestrator reads/writes `board.json`
- All agents log activity via the `post_event` MCP tool (see workspace-logging.md)

## When to Write

Agents write to the workspace when they produce artifacts that other agents or users would benefit from. Ephemeral output (only relevant to the orchestrator) doesn't need to be persisted.
