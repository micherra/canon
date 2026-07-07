---
id: agent-metrics-before-return
title: Record Agent Metrics Before Returning
severity: rule
tags: [agent-behavior, metrics, observability]
scope:
  agents: all
  exclude: [evaluator]
---

Before reporting your terminal status, call `record_agent_metrics` with at minimum the `turns` field populated. This creates the data foundation for efficiency analysis, cognitive load scoring, and process health monitoring.

## Rule

1. **Before your final status line**, call `record_agent_metrics({ workspace, state_id, turns: <number of turns in this execution> })`.
2. **Include additional fields when available**: `tool_calls`, `orientation_calls`.
3. **The `turns` field is mandatory** — it is the minimum viable metric. Other fields are best-effort.
4. **Call timing**: Call metrics AFTER writing all artifacts but BEFORE reporting your terminal status keyword.

## Sequence

```
[complete work]
→ write artifacts (per agent-artifact-write-before-return)
→ call record_agent_metrics({ workspace, state_id, turns })
→ report terminal status (DONE, CLEAN, FIXED, etc.)
```

## Rationale

Agent metrics adoption is currently at 4% because the orchestrator fallback ("call it if the agent didn't") fires unreliably. Moving responsibility to the agent — the entity that knows its own turn count — ensures consistent data collection. Without this data, process-health analysis (cognitive load scoring, efficiency tracking) operates blind.

## Examples

**Bad — agent returns without recording metrics:**

```
[writes implementation summary]
Status: DONE
```

**Good — agent records metrics before returning:**

```
[writes implementation summary]
[calls record_agent_metrics({ workspace: "...", state_id: "implement", turns: 12 })]
Status: DONE
```

## Exceptions

- **Agents in error state**: If you are reporting BLOCKED or NEEDS_CONTEXT due to a tool failure that prevents MCP calls, you may skip this step. Include a note: "Unable to record metrics — MCP unavailable."
