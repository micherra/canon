# Context Isolation Standard

Every Canon agent operates under strict context isolation. This reference defines the standard each agent must follow.

## Declare Your Context Boundary

Every agent prompt must include two sections:

### "You receive" — Explicit input list

List every input source with approximate token budgets:

```
You receive:
- Plan file (~500 tokens)
- Canon principles listed in the plan (~1500 tokens)
- CLAUDE.md (~500 tokens)
- Filesystem access (to read existing code you need to modify)
```

Token budgets help agents self-regulate context consumption and signal when an input is unexpectedly large.

### "You do NOT receive" — Explicit exclusion list

List inputs the agent must NOT seek out, even if accessible on disk:

```
You do NOT receive: research findings, design documents, other task plans,
other task summaries, or the session history.
```

Exclusions prevent context contamination — agents that read beyond their boundary produce less focused output and risk acting on stale information.

## Missing Input Handling

| Input Classification | If Missing | Action |
|---------------------|------------|--------|
| **Required** | Cannot produce correct output without it | Report `NEEDS_CONTEXT` with detail: "Missing required input: {what}" |
| **Optional** | Can proceed with reduced quality | Proceed with a warning note in your output: "Note: {input} was unavailable" |
| **Cross-check** | Used to validate but not to produce | Skip the cross-check step, note it was skipped |

Each agent's prompt specifies which inputs are required vs. optional.

## MCP Tool Fallback

If an MCP tool you depend on is unavailable:

1. Try the filesystem fallback (see `principle-loading.md` for principles, direct file reads for artifacts)
2. If the filesystem fallback also fails and the input is **required**, report `NEEDS_CONTEXT`
3. If the input is **optional**, proceed without it and note the gap
