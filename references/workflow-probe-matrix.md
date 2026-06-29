# Workflow Probe Matrix — canon-probe Canary

## Purpose

`workflows/canon-probe.js` is the **harness-upgrade-stability canary** for Canon's workflow
integration. It runs after every Canon harness upgrade to verify that the Workflow tool itself
still functions correctly end-to-end.

## On-Demand Invocation

Invoke the canary using `scriptPath` (Increment 0 — name-based resolution is Increment 1):

```js
Workflow({ scriptPath: "workflows/canon-probe.js" })
```

Expected result: `{ probe_ok: true, raw: { ok: true, note: "canon-probe passed" } }`

## Probe Matrix (A1 / A2 / A3)

The three assertions canon-probe will check as it evolves into a richer integration probe:

| Probe | Question | What it tests | Inc-0 status |
|-------|----------|---------------|-------------|
| **A1** | Do Canon hooks fire inside workflow agents? | Workflow subagents honor the session's hooks.json registrations (PreToolUse, PostToolUse fire normally) | Deferred to Inc 1+ (requires hook-introspection inside a workflow agent) |
| **A2** | Are Canon agent-type frontmatter allowlists honored inside workflow agents? | `agentType: "canon:reviewer"` resolves and loads the agent's tool allowlist | Deferred to Inc 1+ (requires live invocation in a session where `Workflow` is surfaced) |
| **A3** | Are `Bash` and `git` available to workflow subagents? | Workflow subagents can run shell commands via the Bash tool | Deferred to Inc 1+ (requires live invocation) |

## Inc-0 Scope

In Increment 0, canon-probe exercises the four baseline capabilities required by AC#1:

1. **Boot** — the script parses and the Workflow runtime starts
2. **Agent spawn** — at least one `agent()` call succeeds
3. **Structured-output ingestion** — `opts.schema` forces `StructuredOutput`; the result is
   a validated object (not raw text)
4. **Structured return** — the script's `return { probe_ok, raw }` reaches the caller

These are verified via the CI lint (canon-probe passes `hooks/workflows-lint.sh`) and at the
manual-verification gate where a session with the `Workflow` tool is available.

## Inc-0 → Inc-1 Promotion Gate (§6 Contingency)

Before Increment 1 (args envelope + library install + A1/A2/A3 assertions) can land, the
probe matrix must be evaluated in a live workflow-enabled session:

| Condition | Branch |
|-----------|--------|
| A1 = true, A2 = true | Proceed with Inc 1 as designed (hooks and agent-types work inside workflows) |
| A1 = false OR A2 = false | Select the contingency branch from SYNTHESIS §6: scope down to direct-spawn only, do not route through Canon agents inside workflows until hooks/allowlists are confirmed reachable |
| A3 = false | Document as advisory; shell access may not be available in all workflow runtime environments |

The contingency branches are documented in `docs/explore/workflow-integration/SYNTHESIS.md §6`.
