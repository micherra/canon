---
description: Browse and filter Canon engineering principles
argument-hint: [--severity rule|strong-opinion|convention] [--tag TAG] [--layer LAYER]
allowed-tools: [Read, Glob]
---

List all Canon engineering principles in a formatted table, with optional filtering.

## Instructions

### Step 1: Locate principles

Check both principle directories:
1. **Project-local**: `.canon/principles/` (takes precedence)
2. **Plugin-shipped**: `${CLAUDE_PLUGIN_ROOT}/principles/` (fallback)

If `.canon/principles/` exists, use it (scanning subdirectories `rules/`, `strong-opinions/`, `conventions/`). Otherwise fall back to the plugin directory.

### Step 2: Read all principle files

Glob for `*.md` files in the principles directory. For each file, read the YAML frontmatter to extract:
- `id`, `title`, `severity`, `scope.layers`, `tags`

### Step 3: Apply filters

Parse the arguments from ${ARGUMENTS}:
- `--severity LEVEL` → only show principles at this severity
- `--tag TAG` → only show principles whose tags include TAG
- `--layer LAYER` → only show principles whose layers include LAYER (or whose layers are empty, meaning universal)

### Step 4: Display results

Sort by severity (rules first, then strong-opinions, then conventions) and format as a table:

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
