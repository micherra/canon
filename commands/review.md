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

### Step 3: Spawn the canon-reviewer agent

Launch the canon-reviewer agent as a sub-agent. Provide it with:
- The diff content
- The list of affected files
- A brief description: "Review the following code changes against Canon principles"

**Rate limit handling**: If the agent spawn fails with a rate limit error (e.g. "Rate limit reached", HTTP 429, or "overloaded"), retry up to 3 times with exponential backoff. Wait 4 seconds before the first retry, 8 seconds before the second, and 16 seconds before the third. If all retries fail, inform the user of the rate limit and suggest trying again later.

The reviewer will:
1. Match principles to the affected files
2. Perform Stage 1: Principle Compliance review
3. Perform Stage 2: Principle-Informed Code Quality review
4. Return a structured report

### Step 4: Log the review

After the reviewer returns its report, log the results for drift tracking using the `report` MCP tool (type=review). Pass:
- `files`: The list of affected files from Step 2
- `violations`: The violations array from the reviewer's report (each with `principle_id` and `severity`)
- `honored`: The honored principle IDs from the reviewer's report
- `score`: The score breakdown from the reviewer's report (`rules`, `opinions`, `conventions` with `passed`/`total`)
- `verdict`: The verdict from the reviewer's report header (`BLOCKING`, `WARNING`, or `CLEAN`)

This ensures standalone reviews feed drift data, not just `/canon:build` runs.

### Step 5: Present the report

Display the reviewer's report to the user. The report includes:
- Violations with principle references, severity, and fix suggestions
- Honored principles
- Score breakdown (rules/opinions/conventions)
- Code quality suggestions informed by principles

If there are `rule`-severity violations, highlight them prominently and recommend fixing before committing.
