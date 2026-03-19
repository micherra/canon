---
description: Clean up workspace artifacts and optionally archive to project history
argument-hint: [--branch <name>] [--all] [--archive] [--force]
allowed-tools: [Bash, Read, Write, Glob, Edit]
model: haiku
---

Clean up Canon workspace artifacts. By default, prompts the user to review workspace contents and choose what to keep.

## Parse Flags

From ${ARGUMENTS}, extract:
- `--branch <name>`: Clean a specific branch workspace (default: current branch)
- `--all`: Clean all workspaces
- `--archive`: Archive to `.canon/history/` before cleaning (preserves decisions and notes)
- `--force`: Skip confirmation prompts

## Process

### Step 1: Identify workspaces to clean

If `--all`: list all directories in `.canon/workspaces/`.
If `--branch <name>`: sanitize the branch name and target that workspace.
Otherwise: detect the current git branch and target its workspace.

Branch name sanitization:
```bash
echo "${branch}" | tr '[:upper:]' '[:lower:]' | sed 's|/|--|g' | sed 's/ /-/g' | sed 's/[^a-z0-9-]//g' | head -c 80
```

### Step 2: Show workspace summary

For each workspace to clean, show the user:
- Branch name and creation date (from `session.json`)
- Number of research docs, decisions, plans, reviews
- Size of `log.jsonl` (number of entries)
- Any notes in `notes/`

### Step 3: Ask user what to do

Unless `--force` is set, ask the user:

1. **Archive and clean** — Move decisions, notes, and a summary to `.canon/history/{sanitized-branch}/`, then delete the workspace
2. **Clean without archiving** — Delete the workspace entirely
3. **Cancel** — Do nothing

If `--archive` flag is set, default to option 1 without asking.

### Step 4: Archive (if chosen)

Create `.canon/history/{sanitized-branch}/` and preserve:

```
.canon/history/{sanitized-branch}/
├── archive-meta.json         # When archived, original branch, task description
├── decisions/                # All design decision docs (valuable long-term)
├── notes/                    # User and agent notes
└── summary.md                # Auto-generated summary of what happened
```

Generate `summary.md` by reading:
- `session.json` for task description and dates
- `log.jsonl` for agent activity timeline
- Any review verdicts from `reviews/`
- Decision titles from `decisions/`

Format:

```markdown
## Workspace Archive: {branch}

**Task**: {description}
**Period**: {created} to {archived}
**Status**: {status from session.json}

### Activity
- {N} research docs produced
- {N} design decisions made
- {N} implementation tasks completed
- Review verdict: {verdict}

### Key Decisions
- {decision-id}: {title}

### Notes
- {any notes content}
```

### Step 5: Clean

Delete the workspace directory:
```bash
rm -rf .canon/workspaces/{sanitized-branch}
```

### Step 6: Report

Tell the user:
- What was cleaned
- What was archived (if applicable) and where to find it
- Suggest: "Run `/canon:status` to verify project health"
