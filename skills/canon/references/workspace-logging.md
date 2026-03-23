# Workspace Activity Logging

This is the canonical logging protocol for all Canon agents operating within a workspace.

## Format

Append entries to `${WORKSPACE}/log.jsonl` (one JSON object per line, append-only):

```json
{"timestamp": "ISO-8601", "agent": "{your-agent-name}", "action": "start", "detail": "{what you are beginning}"}
{"timestamp": "ISO-8601", "agent": "{your-agent-name}", "action": "complete", "detail": "{summary of outcome}", "artifacts": ["{relative/path/to/output}"]}
```

## When to Log

- **Start entry**: Append when you begin your primary work (after reading inputs, before producing output)
- **Complete entry**: Append when you finish, including your status and artifact paths

## Artifact Paths

Report artifact paths **relative to `${WORKSPACE}`** (e.g., `plans/add-auth/DESIGN.md`, not the full absolute path). The orchestrator resolves them by prepending the workspace path.

## When `${WORKSPACE}` Is Not Provided

Skip logging silently. Do not fail, do not report NEEDS_CONTEXT for missing logging alone — logging is observability, not a prerequisite for your work.
