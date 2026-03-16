---
description: View Canon orchestration pipeline status, Ralph loop state, and event timeline
argument-hint: [--task <slug>] [--open]
allowed-tools: [Bash, Read]
model: haiku
---

Display the current orchestration state — pipeline progress, Ralph loop iterations, and recent events.

## Instructions

### Step 1: Get orchestration data

Call the `get_orchestration_data` MCP tool. If `--task` is provided, pass it as `task_slug`.

### Step 2: Display pipeline

Show the pipeline stages as a horizontal flow:

```
Pipeline: research → architect → plan → implement → test → security → review
          ✓ done     ✓ done     ● run   ○ pending   ○       ○         ○
```

Use these indicators:
- `✓` completed (green)
- `●` running (blue)
- `✗` blocked (red)
- `○` pending (gray)

List agents under each active/completed stage.

### Step 3: Display Ralph loop (if present)

```
Ralph Loop — Iteration 2/3
  #1: BLOCKING — 5 violations, 3 fixed
  #2: WARNING  — 2 violations, 1 fixed
```

### Step 4: Display recent events

Show the last 10 events with timestamp, type, agent, and status.

### Step 5: Save and optionally open UI

Save orchestration data to `.canon/orchestration-data.json`.

If `--open` is provided:
```bash
open ui/index.html#orchestration || xdg-open ui/index.html#orchestration || echo "Open ui/index.html in your browser"
```
