---
description: Edit an existing Canon principle or agent-rule interactively
argument-hint: <principle-id> [--severity rule|strong-opinion|convention] [--add-tag TAG] [--remove-tag TAG] [--archive] [--unarchive]
allowed-tools: [Read, Write, Edit, Bash, Glob, Agent]
model: sonnet
---

Thin router for Canon principle/agent-rule editing.

Authority model:
- `agents/writer.md` owns editing behavior and decision logic
- `references/principle-format.md` is the source of truth for file structure
- This command should not duplicate authoring or validation policy

## Instructions

### Step 1: Spawn the writer

Launch the writer agent:

"Mode: edit. The user wants to edit a Canon principle or agent-rule: ${ARGUMENTS}"

If no arguments, ask the user which principle they want to edit. Suggest asking Canon to list principles to browse available entries.

### Step 2: Delegate completely

Do not restate editing rules here. Let writer:
- load the entry
- resolve requested edits
- normalize structure to the format spec
- validate and save

### Step 3: Confirm changes

After the agent completes, confirm to the user:
- Which fields were changed (before → after)
- Where the file was saved
- Whether structure was normalized to the format spec
- Suggest asking Canon to list principles to verify
- If severity changed: "Enforcement level updated — this takes effect on the next review."
