---
description: Lightweight principle compliance check on staged or specified files — no workspace, no orchestrator
argument-hint: [--staged] [file...] [--strict]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
model: sonnet
---

Quick principle compliance check for staged changes or specific files. Designed for pre-commit use — fast, focused, no build pipeline overhead.

## Parse Arguments

From ${ARGUMENTS}, extract:
- **`--staged`** (default if no args): Check staged changes via `git diff --cached`
- **File paths**: Check specific files (e.g., `src/api/orders.ts src/services/order.ts`)
- **`--strict`**: Treat WARNING (strong-opinion violations) as failures alongside BLOCKING

If no arguments provided, default to `--staged`.

## Step 1: Get Changed Files

**Staged mode**: Run `git diff --cached --name-only`. If empty, report "No staged changes to check." and exit.

**File mode**: Use the provided file paths directly. Verify each exists.

## Step 2: Get the Diff

- Staged: `git diff --cached`
- Files: `git diff HEAD -- {file1} {file2} ...`

If the diff is empty, report "No changes to check." and exit.

## Step 3: Load Principles

Call the `get_principles` MCP tool for each changed file path. Deduplicate across files. Cap at 10 principles total, prioritized: rules > strong-opinions > conventions.

If the MCP tool is unavailable, fall back to globbing `.canon/principles/**/*.md` then `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md` and matching by file path patterns.

## Step 4: Spawn Reviewer

Spawn a `canon-reviewer` sub-agent with this scoped prompt:

"Lightweight compliance check — Stage 1 (principle compliance) ONLY.
- Skip Stage 2 (code quality suggestions)
- Skip Stage 3 (compliance cross-check)
- No workspace, no artifact saving
- Report verdict and violations only

Diff:
{the diff}

Matched Principles:
{principle summaries and examples}

End with: STATUS: CLEAN|WARNING|BLOCKING"

## Step 5: Present Results

Based on the reviewer's verdict:

**CLEAN**:
```
✓ All clear — {N} principles checked across {M} files, no violations.
```

**WARNING**:
```
⚠ {N} strong-opinion violation(s) found:

  {principle-id} in {file}:{line} — {description}
  → {fix suggestion}

These are advisory — commit proceeds unless --strict is set.
```

**BLOCKING**:
```
✗ {N} rule violation(s) — must fix before committing:

  {principle-id} in {file}:{line} — {description}
  → {fix suggestion}

Fix these violations before committing.
```

## Integration

Suggest to the user after first run:
"Tip: Add `/canon:check --staged` to your pre-commit hook for automatic principle checking."
