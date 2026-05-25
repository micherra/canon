---
description: Structured diagnosis for bugs and failures
argument-hint: <description of the problem>
allowed-tools: [Read, Bash, Grep, Glob, WebFetch, mcp__canon__semantic_search, mcp__canon__get_file_context, mcp__canon__graph_query, Edit, Write]
model: sonnet
---

Run a structured 7-step diagnosis process for the problem described in `${ARGUMENTS}`. Follow each step in order. Do not skip steps.

## Instructions

### Step 1: Parse the problem description

From `${ARGUMENTS}`, extract and state explicitly:
- What is broken (the observed failure)
- When it started, if known
- Any error messages or stack traces provided

If `${ARGUMENTS}` is empty, ask: "What problem would you like to diagnose? Describe what's broken, when it started, and any error messages you've seen."

### Step 2: Build the feedback loop

Before any investigation, establish a reproducible feedback loop. State each element explicitly:

- **Trigger**: What action causes the problem? (e.g., "run `npm test`", "open the login page", "deploy to staging")
- **Symptom**: What does failure look like? (e.g., "test fails with TypeError", "page returns 500", "request hangs for 30s then times out")
- **Confirmation signal**: How will you know it's fixed? (e.g., "test passes", "page returns 200", "p99 latency drops below 100ms")

If the problem cannot be reproduced, note that explicitly and describe the available evidence (logs, error reports, monitoring artifacts). Proceed with artifact-based diagnosis but flag that confirmation will be harder.

### Step 3: Generate hypotheses

Generate 3-5 hypotheses. For each hypothesis:
- Name the suspected component or file
- State the suspected mechanism: "X fails because Y"
- Define the falsification test: one command or check that would eliminate this hypothesis in under a minute

Then rank the hypotheses by ease of falsification — the fastest to test goes first.

### Step 4: Test hypotheses

Starting with the easiest-to-falsify hypothesis, run its falsification test. Record the result:
- **Confirmed** — the test positively identified this as the cause; stop and proceed to Step 5
- **Eliminated** — the test ruled out this hypothesis; move to the next
- **Inconclusive** — the test did not produce a clear signal; note what was observed and continue

If all hypotheses are eliminated, generate a second round of hypotheses based on what was learned. Apply the 10-minute time-box: if a falsification test hasn't produced a clear result in 10 minutes, record what was found and move to the next hypothesis.

### Step 5: Localize and fix

Once a hypothesis is confirmed:
1. Apply `agent-structured-triage` — the 5-step fix protocol: reproduce, localize, reduce, fix, guard.
2. Load `${CLAUDE_PLUGIN_ROOT}/primers/diagnosis.md` for mental model guidance during the fix.
3. Write a test that guards against regression before applying the fix.

If the fix requires architectural changes beyond this task's scope, note that and report the minimal containment fix separately from the architectural improvement.

### Step 6: Post-mortem handoff

After fixing:
- State the root cause in one sentence.
- Ask: "What would have caught this earlier?" — missing test coverage, unclear contract, absent monitoring?
- State what architectural improvement would prevent this class of bug.
- If the improvement is actionable as a single task, phrase it as a follow-up build suggestion.

### Step 7: Present results

Write a structured diagnosis report:

```markdown
## Diagnosis Report

### Problem
{description from Step 1}

### Feedback Loop
- Trigger: {trigger}
- Symptom: {symptom}
- Confirmation: {signal}

### Hypotheses Tested
| # | Hypothesis | Result | Evidence |
|---|-----------|--------|----------|
| 1 | {component}: {mechanism} | confirmed / eliminated / inconclusive | {what the falsification test showed} |

### Root Cause
{one sentence}

### Fix Applied
{description of what was changed, or "none — see post-mortem" if fix is out of scope}

### Post-Mortem
**What would have caught this earlier:** {missing coverage, contract, or monitoring}
**Architectural improvement:** {suggestion, or "none identified"}
**Suggested follow-up:** {follow-up build description, if applicable}
```
