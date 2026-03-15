---
description: Edit an existing Canon principle or agent-rule interactively
argument-hint: <principle-id> [--severity rule|strong-opinion|convention] [--add-tag TAG] [--remove-tag TAG]
allowed-tools: [Read, Write, Edit, Bash, Glob, Agent]
---

Edit an existing Canon principle or agent-rule using the canon-principle-editor agent. The agent will load the current state, walk through changes, check for conflicts, and save the result.

## Instructions

### Step 1: Spawn the principle editor

Launch the canon-principle-editor agent with the principle ID from ${ARGUMENTS}:

"The user wants to edit a Canon principle or agent-rule: ${ARGUMENTS}"

If no arguments, ask the user which principle they want to edit. Suggest running `/canon:list` to browse available principles.

### Step 2: Let the agent work

The canon-principle-editor will:
1. Load and display the current principle
2. Ask what the user wants to change (or apply flags directly)
3. Handle severity changes including file moves
4. Check for conflicts with other principles
5. Save the updated file
6. Validate the result

### Step 3: Confirm changes

After the agent completes, confirm to the user:
- Which fields were changed (before → after)
- Where the file was saved
- Any conflicts that were flagged
- Suggest running `/canon:list` to verify
- If severity changed: "Enforcement level updated — this takes effect on the next review."
