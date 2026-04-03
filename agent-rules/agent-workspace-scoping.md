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
├── session.json              # Session metadata
├── board.json                # Flow execution state (states, transitions, iterations)
├── board.json.bak            # Board backup — previous valid state for crash recovery
├── progress.md               # Append-only learnings across iterations
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
├── transcripts/              # Agent execution transcripts
│   └── {state_id}--{agent_type}--{ts}.jsonl
└── handoffs/                 # Structured cross-agent communication
    ├── research-synthesis.md
    ├── design-brief.md
    ├── impl-handoff.md
    └── test-findings.md
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
| **intake** | board.json, session.json (read-only for status) | — (no workspace writes; spawns orchestrator) |
| **orchestrator** | board.json, session.json, flow templates | board.json, session.json, progress.md, log.jsonl |
| **researcher** | templates/, session.json | research/, handoffs/research-synthesis.md, log.jsonl |
| **architect** | research/, templates/, session.json, context.md, handoffs/research-synthesis.md | decisions/, plans/, handoffs/design-brief.md, log.jsonl, context.md |
| **implementor** | plans/{slug}/{task}-PLAN.md, context.md, decisions/, handoffs/design-brief.md | plans/{slug}/{task}-SUMMARY.md, handoffs/impl-handoff.md, log.jsonl |
| **tester** | plans/{slug}/*-SUMMARY.md, context.md, handoffs/impl-handoff.md | plans/{slug}/TEST-REPORT.md, handoffs/test-findings.md, log.jsonl |
| **fixer** | plans/{slug}/*-SUMMARY.md, handoffs/test-findings.md | log.jsonl |
| **security** | plans/{slug}/*-SUMMARY.md, handoffs/ (read all) | plans/{slug}/SECURITY.md, log.jsonl |
| **reviewer** | plans/{slug}/*-SUMMARY.md (post-Stage-2 cross-check only), handoffs/ (read all) | plans/{slug}/REVIEW.md, reviews/, log.jsonl |
| **scribe** | plans/{slug}/*-SUMMARY.md, CLAUDE.md, context.md, .canon/CONVENTIONS.md | plans/{slug}/CONTEXT-SYNC.md, CLAUDE.md, context.md, .canon/CONVENTIONS.md, log.jsonl |
| **refactorer** | reviews/, decisions/, context.md | log.jsonl |
| **learner** | everything in workspace | log.jsonl |
| **writer** | everything in workspace | — |

Key constraints:
- **Build lock**: `.lock` prevents concurrent builds. Stale locks (>2 hours) are auto-removed.
- **Board backup**: `board.json.bak` written before every update for crash recovery.
- Only the orchestrator reads/writes `board.json`
- All agents append to `log.jsonl`
- **Handoff injection**: Handoff reads listed above are auto-injected by the pipeline — agents do not need to manually read handoff files. The pipeline injects the relevant handoff as `${handoff_context}` in the consuming agent's spawn prompt.

## Handoff Files

Handoff files in `handoffs/` provide structured cross-agent communication. Each handoff is:
- **Written** by the producing agent via the `write_handoff` MCP tool
- **Read** automatically by the prompt pipeline and injected into the consuming agent's spawn prompt as `${handoff_context}`

Agents do not need to manually read handoff files — the pipeline handles injection. The `write_handoff` tool validates content structure per handoff type.

| Handoff | Producer | Consumer | Content |
|---------|----------|----------|---------|
| research-synthesis.md | Researcher | Architect | Key findings, affected subsystems, risk areas, open questions |
| design-brief.md | Architect | Implementor | Approach, file targets, constraints, test expectations |
| impl-handoff.md | Implementor | Tester | Files changed, coverage notes, risk areas, compliance status |
| test-findings.md | Tester | Fixer | Failure details, reproduction steps, affected files, categories |

## Log Entry Format

Every agent appends a JSON line to `log.jsonl` when starting or completing work:

```json
{"timestamp": "ISO-8601", "agent": "canon-researcher", "action": "start", "detail": "Codebase research for order-creation"}
{"timestamp": "ISO-8601", "agent": "canon-researcher", "action": "complete", "detail": "Found 3 relevant patterns", "artifacts": ["research/codebase.md"]}
```

## When to Write

Agents write to the workspace when they produce artifacts that other agents or users would benefit from. Ephemeral output (only relevant to the orchestrator) doesn't need to be persisted.
