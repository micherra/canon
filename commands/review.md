---
description: Review code changes against Canon engineering principles
argument-hint: [--staged | HEAD~N | main..HEAD | file-path]
allowed-tools: [Bash, Read, Glob, Grep, Agent]
model: sonnet
---

Review code changes against Canon engineering principles using the canon-reviewer agent. Performs a two-stage evaluation: principle compliance, then principle-informed code quality.

## Instructions

### Step 1: Determine review scope

Parse ${ARGUMENTS} to determine what to review:

- **No arguments** or `--staged`: Review staged changes (`git diff --cached`)
- **`HEAD~N`**: Review last N commits (`git diff HEAD~N`)
- **`main..HEAD`** or `branch..HEAD`: Review branch diff
- **File path(s)**: Review specific files (read them directly)

Get the diff:
```bash
git diff --cached                    # staged
git diff HEAD~3                      # last 3 commits
git diff main..HEAD                  # branch diff
```

If the diff is empty, tell the user there are no changes to review.

### Step 2: Identify affected files

Extract the list of files from the diff:
```bash
git diff --cached --name-only        # or appropriate variant
```

### Step 3: Pre-load principles

Before spawning the reviewer, call the `review_code` MCP tool for each affected file to get matched principles. Deduplicate by principle ID. This avoids the reviewer redundantly re-loading principles from disk.

### Step 4: Spawn the canon-reviewer agent

Launch the canon-reviewer agent as a sub-agent. Provide it with:
- The diff content
- The list of affected files
- The pre-loaded matched principles (full body) from Step 3
- A brief description: "Review the following code changes against Canon principles. Matched principles are provided below — do not re-load them."

The reviewer will:
1. Use the pre-loaded principles (already matched to affected files)
2. Perform Stage 1: Principle Compliance review
3. Perform Stage 2: Principle-Informed Code Quality review
4. Return a structured report

### Step 5: Log the review

After the reviewer returns its report, log the results for drift tracking using the `report` MCP tool (type=review). Pass:
- `files`: The list of affected files from Step 2
- `violations`: The violations array from the reviewer's report (each with `principle_id` and `severity`)
- `honored`: The honored principle IDs from the reviewer's report
- `score`: The score breakdown from the reviewer's report (`rules`, `opinions`, `conventions` with `passed`/`total`)
- `verdict`: The verdict from the reviewer's report header (`BLOCKING`, `WARNING`, or `CLEAN`)

This ensures standalone reviews feed drift data, not just `/canon:build` runs.

### Step 6: Present the report

Display the reviewer's report to the user. The report includes:
- Violations with principle references, severity, and fix suggestions
- Honored principles
- Score breakdown (rules/opinions/conventions)
- Code quality suggestions informed by principles

If there are `rule`-severity violations, highlight them prominently and recommend fixing before committing.
