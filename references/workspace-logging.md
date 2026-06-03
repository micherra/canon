# Workspace Activity Logging

This is the canonical logging protocol for all Canon agents operating within a workspace.

## How to Log

Call the `post_event` MCP tool with your agent name, action, detail, and workspace path:

**Start entry** (when you begin your primary work):
```
post_event({
  workspace: "${WORKSPACE}",
  agent: "{your-agent-name}",
  action: "start",
  detail: "{what you are beginning}"
})
```

**Complete entry** (when you finish):
```
post_event({
  workspace: "${WORKSPACE}",
  agent: "{your-agent-name}",
  action: "complete",
  detail: "{summary of outcome}",
  artifacts: ["{relative/path/to/output}"]
})
```

## When to Log

- **Start entry**: Call when you begin your primary work (after reading inputs, before producing output)
- **Complete entry**: Call when you finish, including your status and artifact paths

## Artifact Paths

Report artifact paths **relative to `${WORKSPACE}`** (e.g., `plans/<slug>/DESIGN.md`, not the full absolute path). The orchestrator resolves them by prepending the workspace path.

## When `${WORKSPACE}` Is Not Provided

Skip logging silently. Do not fail, do not report NEEDS_CONTEXT for missing logging alone — logging is observability, not a prerequisite for your work.
