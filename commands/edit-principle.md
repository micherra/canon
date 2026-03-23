---
description: Edit an existing Canon principle or agent-rule interactively
argument-hint: <principle-id> [--severity rule|strong-opinion|convention] [--add-tag TAG] [--remove-tag TAG] [--archive] [--unarchive]
allowed-tools: [Read, Write, Edit, Bash, Glob, Agent]
model: sonnet
---

Edit an existing Canon principle or agent-rule using the canon-writer agent in **edit** mode.

## Instructions

### Step 1: Spawn the writer

Launch the canon-writer agent:

"Mode: edit. The user wants to edit a Canon principle or agent-rule: ${ARGUMENTS}"

If no arguments, ask the user which principle they want to edit. Suggest asking Canon to list principles to browse available entries.

### Step 2: Let the agent work

The canon-writer will:
1. Load and display the current entry
2. Ask what the user wants to change (or apply flags directly)
3. Handle severity changes including file moves
4. Check for conflicts with other entries
5. Save the updated file
6. Validate the result

### Step 3: Confirm changes

After the agent completes, confirm to the user:
- Which fields were changed (before → after)
- Where the file was saved
- Any conflicts that were flagged
- Suggest asking Canon to list principles to verify
- If severity changed: "Enforcement level updated — this takes effect on the next review."
