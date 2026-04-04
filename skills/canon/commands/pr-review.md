---
description: Review a PR or branch against Canon principles
argument-hint: <PR-number|branch> [--post-comments] [--incremental] [--layer api|ui|domain|data|infra|shared]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
model: sonnet
---

Thin launcher for the `review-only` flow with GitHub integration. Parses PR-specific arguments, invokes the flow, then handles GitHub side-effects (posting comments, logging).

## Instructions

### Step 1: Parse arguments

From ${ARGUMENTS}, extract:
- **PR number or branch**: The PR to review (e.g., `42`, `feature/auth`, `main..HEAD`)
- `--post-comments`: Post inline review comments to GitHub after review
- `--incremental`: Only review commits since the last Canon review of this PR
- `--layer <name>`: Only review files in the specified architectural layer

### Step 2: Compute review scope

Build a `review_scope` object for the orchestrator:

- If PR number: `{ type: "pr", target: "{number}" }`
- If branch: `{ type: "branch", target: "{branch}" }`
- If `--incremental`: Query `DriftStore.getLastReviewForPr(number)` (reads from `.canon/reviews.jsonl`) for the last reviewed SHA for this PR. Set `{ type: "pr", target: "{number}", since_sha: "{sha}" }`

If `--layer` is specified, add `layer: "{name}"` to the scope.

### Step 3: Launch review-only flow

Invoke the orchestrator with:
- `flow: review-only`
- `task: "Review PR #{number}"` (or branch name)
- `review_scope`: the object from Step 2

Wait for the flow to complete.

### Step 4: Handle GitHub side-effects

If `--post-comments` was specified:

1. Derive repo identity:
   ```bash
   gh repo view --json owner,name -q '.owner.login + "/" + .name'
   ```

2. Read the review artifact from the workspace. For each violation, post an inline review comment via `gh api`.

3. Post the review summary as a PR comment.

### Step 5: Log and present

Log the review to `.canon/pr-reviews/{number}/REVIEW.md` and update `.canon/reviews.jsonl` (via `DriftStore.appendReview`) with the current HEAD SHA (for `--incremental` support).

Display the review to the user:
- Verdict prominently displayed
- Violations with fix suggestions
- Per-layer score breakdown (if layer-parallel review was triggered)
- If `--post-comments` was used: "Comments posted to PR #{number}"
