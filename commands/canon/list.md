---
description: Browse and filter Canon engineering principles
argument-hint: [--severity rule|strong-opinion|convention] [--tag TAG] [--layer LAYER]
allowed-tools: [Bash, Read, Glob]
---

List all Canon engineering principles in a formatted table, with optional filtering.

## Instructions

### Step 1: Locate principles

Check both principle directories:
1. **Project-local**: `.canon/principles/` (takes precedence)
2. **Plugin-shipped**: `${CLAUDE_PLUGIN_ROOT}/principles/` (fallback)

If `.canon/principles/` exists, use it. Otherwise fall back to the plugin directory.

### Step 2: Run the matcher

Use the principle matcher to get all principles with optional filters from ${ARGUMENTS}:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh [OPTIONS] [PRINCIPLES_DIR]
```

Parse the arguments from ${ARGUMENTS}:
- `--severity LEVEL` → pass as `--severity-filter LEVEL`
- `--tag TAG` → filter results by tag after matching
- `--layer LAYER` → pass as `--layer LAYER`
- `--language LANG` → pass as `--language LANG`

### Step 3: Display results

Format the matched principles as a table:

```
| ID                          | Severity        | Title                                    | Tags                           |
|-----------------------------|-----------------|------------------------------------------|--------------------------------|
| simplicity-first            | strong-opinion  | The Simplest Thing That Could Work       | simplicity, architecture       |
| thin-handlers               | strong-opinion  | Handlers Are Thin Orchestrators          | separation-of-concerns         |
```

At the bottom, show:
- Total count of principles shown
- Which filters were applied (if any)
- Where principles are loaded from (project-local or plugin)

If `--tag TAG` was specified, filter the results to only show principles whose tags contain TAG.
