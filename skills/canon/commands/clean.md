---
description: Clean up workspace artifacts
argument-hint: [--branch <name>] [--all] [--force]
allowed-tools: [Bash, Read, Write, Glob, Edit]
model: haiku
---

Clean up Canon workspace artifacts. By default, prompts the user to review workspace contents and choose what to keep.

## Parse Flags

From ${ARGUMENTS}, extract:
- `--branch <name>`: Clean a specific branch workspace (default: current branch)
- `--all`: Clean all workspaces
- `--force`: Skip confirmation prompts — **caution: permanently deletes workspace data without review.**

## Process

### Step 1: Identify workspaces to clean

If `--all`: list all directories in `.canon/workspaces/`.
If `--branch <name>`: sanitize the branch name and target that workspace.
Otherwise: detect the current git branch and target its workspace.

Branch name sanitization: lowercase, replace `/` with `--` and spaces with `-`, strip non-alphanumeric except `-`, truncate to 80 chars.

### Step 2: Show workspace summary

For each workspace to clean, show the user:
- Branch name and creation date (from `session.json`)
- Number of research docs, decisions, plans, reviews
- Size of `log.jsonl` (number of entries)
- Number of transcript files in `transcripts/`
- Any notes in `notes/`

### Step 3: Ask user what to do

Unless `--force` is set, ask the user:

1. **Clean** — Delete the workspace entirely
2. **Cancel** — Do nothing

### Step 4: Clean

Delete the workspace directory:
```bash
rm -rf .canon/workspaces/{sanitized-branch}
```

### Step 5: Report

Tell the user:
- What was cleaned
- Suggest: "Ask Canon for status to verify project health"
