---
description: Initialize Canon principles in your project
argument-hint: [--starter|--empty]
allowed-tools: [Bash, Read, Write, Glob, Edit]
model: haiku
---

Initialize Canon engineering principles in the current project. This sets up the `.canon/principles/` directory and integrates with CLAUDE.md.

## Instructions

### Step 1: Create the Canon directory structure

```bash
mkdir -p .canon/principles/rules .canon/principles/strong-opinions .canon/principles/conventions
mkdir -p .canon/workspaces .canon/history
```

### Step 2: Copy starter principles

If the user passed `--empty` as an argument, skip this step and just create an empty `.canon/principles/` directory structure.

Otherwise (default behavior), copy all principle files from the plugin's starter set, preserving the severity subdirectory structure:

```bash
cp ${CLAUDE_PLUGIN_ROOT}/principles/rules/*.md .canon/principles/rules/
cp ${CLAUDE_PLUGIN_ROOT}/principles/strong-opinions/*.md .canon/principles/strong-opinions/
cp ${CLAUDE_PLUGIN_ROOT}/principles/conventions/*.md .canon/principles/conventions/
```

### Step 3: Create default config

Create `.canon/config.json` with sensible defaults:

```json
{
  "source_dirs": ["src"],
  "principle_dirs": [".canon/principles"],
  "layer_patterns": {},
  "review": {
    "max_principles_per_review": 10,
    "include_honored_in_output": true
  },
  "hook": {
    "pre_commit_severity": "rule",
    "warn_on_opinions": true
  }
}
```

### Step 4: Update CLAUDE.md

Check if `CLAUDE.md` exists in the project root. If it does, check whether it already contains a "Canon" section. If not, append the following section:

```markdown

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Principles are in `.canon/principles/`. Run `/canon:list` to browse them.
```

If `CLAUDE.md` doesn't exist, create it with just the Canon section above.

### Step 5: Auto-detect project conventions

Scan the existing codebase to infer conventions and pre-populate `.canon/CONVENTIONS.md`. This gives new projects a useful starting point instead of a blank template.

Detect the language/framework from config files (package.json, go.mod, Cargo.toml, etc.). Sample 10-20 source files to detect naming, error handling, testing, import, and validation patterns.

#### Write CONVENTIONS.md

Create `.canon/CONVENTIONS.md` with detected conventions:

```markdown
## Project Conventions

> Project-specific patterns and decisions. Auto-detected by `/canon:init` and refined as the project evolves.
> Implementor agents read this file alongside Canon principles.

{detected conventions as bullets, e.g.:}
- **Naming**: camelCase for functions and variables, PascalCase for types and components
- **File naming**: kebab-case for files and directories
- **Error handling**: try/catch with custom error classes
- **Testing**: Vitest with inline test data
- **Validation**: Zod schemas at API boundaries
- **Data layer**: Prisma ORM with repository pattern
```

If no conventions could be detected (empty project or unrecognizable stack), fall back to the blank template:

```markdown
## Project Conventions

> Project-specific patterns and decisions. Updated as the project evolves.
> Implementor agents read this file alongside Canon principles.

<!-- Add your project conventions below. Examples: -->
<!-- - **Error handling**: Use result types, not thrown exceptions -->
<!-- - **Validation**: Zod schemas at API boundaries -->
<!-- - **Testing**: Vitest with inline test data -->
```

### Step 6: Report what was done

Tell the user what was created (principles, conventions, workspaces, CLAUDE.md) and suggest next steps: `/canon:list` to browse principles, edit `.canon/CONVENTIONS.md` to add conventions, and add `.canon/` to git tracking.
