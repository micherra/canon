---
description: Review a PR or branch against Canon principles with per-layer parallel review
argument-hint: <PR-number|branch> [--post-comments] [--incremental] [--layer api|ui|domain|data|infra|shared]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
model: sonnet
---

Review a pull request or branch against Canon engineering principles. Groups changed files by architectural layer and spawns parallel reviewers for focused, deep reviews.

## Parse Arguments

From ${ARGUMENTS}, extract:
- **PR number or branch**: The PR to review (e.g., `42`, `feature/auth`, `main..HEAD`)
- `--post-comments`: Post inline review comments to GitHub via `gh api`
- `--incremental`: Only review commits since the last Canon review of this PR
- `--layer <name>`: Only review files in the specified architectural layer

## Step 1: Get the Diff

Determine the diff source:
- If PR number: `gh pr diff {number}`
- If branch: `git diff main..{branch}`
- If `--incremental`: Check `.canon/pr-reviews.jsonl` for the last reviewed SHA, then `git diff {sha}..HEAD`

Get the list of changed files:
```bash
gh pr diff {number} --name-only  # or git diff variant
```

## Step 2: Group by Layer

For each changed file, infer the architectural layer using file path patterns:
- `/api|routes|controllers/` → api
- `/app|components|pages|views/` → ui
- `/services|domain|models/` → domain
- `/db|data|repositories|prisma/` → data
- `/infra|deploy|terraform|docker/` → infra
- `/utils|lib|shared|types/` → shared

If `--layer` was specified, filter to only that layer.

## Step 3: Load Principles

For each layer group, call the `get_principles` MCP tool with a representative file path to get matched principles. Deduplicate across groups.

## Step 4: Spawn Parallel Reviewers

For each layer group with changes, spawn a canon-reviewer agent:

"Review the following files against Canon principles. You receive ONLY the diff for {layer} files and the matched principles below — this is a cold review.

Files: {file list}
Diff: {the actual diff for these files}
Matched Principles: {principles for this layer}

Produce a structured review report with violations, honored principles, score, and verdict."

Wait for all reviewers to complete.

## Step 5: Merge Reports

Combine all layer review reports into a unified PR review:

```markdown
## Canon PR Review — PR #{number}

### Verdict: {worst verdict across all layers}

### Layer Reviews
#### API Layer (N files)
{violations, honored, score}

#### Domain Layer (N files)
{violations, honored, score}

### Combined Score
Rules: X/Y | Opinions: X/Y | Conventions: X/Y

### Violations Summary
- [principle-id] (severity) in file: description — fix suggestion
```

## Step 6: Post Comments (if --post-comments)

For each violation, post an inline review comment to GitHub:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --method POST \
  -f event=COMMENT \
  -f body="Canon Review Summary: {verdict}" \
  --jq '.id'
```

For inline comments on specific lines, use the review comments API.

## Step 7: Log the Review

Use the `report` MCP tool (type=review) to log the unified results for drift tracking.

Also save to `.canon/pr-reviews/{number}/REVIEW.md` and update the PR review history in `.canon/pr-reviews.jsonl` with the current HEAD SHA (for incremental support).

## Step 8: Present Results

Display the unified review to the user:
- Verdict prominently displayed
- Violations with fix suggestions
- Per-layer score breakdown
- If `--post-comments` was used: "Comments posted to PR #{number}"
- Tip: "Review the violations and fix them manually or with AI assistance."
