---
description: Archive or unarchive a Canon principle or agent-rule
argument-hint: <principle-id>
allowed-tools: [Read, Edit, Glob]
model: haiku
---

Toggle the `archived` flag on a Canon principle or agent-rule. Archived entries stay on disk but are skipped by the matcher — they won't appear in reviews, `get_principles`, or `review_code` results.

## Instructions

### Step 1: Find the entry

Extract the principle or agent-rule ID from ${ARGUMENTS}.

If no argument provided, list available entries and ask the user which one to toggle.

Search for the entry by ID in:
1. `.canon/principles/**/*.md` (project-local principles)
2. `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md` (built-in principles)
3. `.canon/agent-rules/*.md` (project-local agent-rules)
4. `${CLAUDE_PLUGIN_ROOT}/agent-rules/*.md` (built-in agent-rules)

### Step 2: Read current state

Read the file's frontmatter. Check if `archived: true` is present.

If the entry is built-in (lives in plugin directory), warn:
"This is a built-in entry. The archive override will be saved as a project-local copy in `.canon/` which takes precedence."

### Step 3: Toggle the flag

- If currently **active** (no `archived` field or `archived: false`):
  - Add `archived: true` to the frontmatter
  - If built-in, copy the file to the project-local location first, then add the flag
  - Confirm: "Archived `{id}` ({title}). It will no longer appear in reviews or principle loading. Use `/canon:toggle-archive {id}` to re-enable."

- If currently **archived** (`archived: true`):
  - Remove the `archived` line from frontmatter (or set to `false`)
  - Confirm: "Unarchived `{id}` ({title}). It is now active and will appear in reviews again."

### Step 4: Show context

After toggling, show the entry's id, title, severity, and current state. Suggest asking Canon to list principles to verify.
