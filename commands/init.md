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

#### 5a: Detect language and framework

Look for telltale files to identify the stack:
- `package.json` → Node.js (check for React, Next.js, Express, etc. in dependencies)
- `requirements.txt` / `pyproject.toml` / `setup.py` → Python (check for Django, Flask, FastAPI, etc.)
- `go.mod` → Go
- `Cargo.toml` → Rust
- `*.csproj` / `*.sln` → .NET
- `Gemfile` → Ruby

#### 5b: Scan for naming patterns

Sample 10-20 source files across the project and detect:
- **Naming convention**: camelCase vs snake_case vs PascalCase for functions/variables
- **File naming**: kebab-case vs camelCase vs PascalCase for filenames
- **Export style**: default exports vs named exports (JS/TS)

#### 5c: Scan for structural patterns

Look for recurring patterns:
- **Error handling**: Do files use try/catch, Result types, error codes, or `.catch()`?
- **Testing framework**: Jest, Vitest, pytest, Go testing, etc. (check devDependencies or test files)
- **Import style**: Relative vs absolute imports, barrel files (index.ts re-exports)
- **Validation**: Zod, Joi, class-validator, Pydantic, etc.
- **ORM/data layer**: Prisma, Drizzle, SQLAlchemy, GORM, etc.
- **API style**: REST routes, GraphQL, tRPC, gRPC

#### 5d: Write CONVENTIONS.md

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

This file is the persistent, project-level conventions layer. It gets read by implementor and refactorer agents. Edit `.canon/CONVENTIONS.md` directly as patterns emerge.

### Step 6: Report what was done

Tell the user:
- How many principles were copied (or that an empty directory was created)
- That `.canon/CONVENTIONS.md` was created (for project-level conventions)
- That CLAUDE.md was updated/created
- Suggest running `/canon:status` to verify the setup
- Suggest running `/canon:list` to browse the principles
- Suggest editing `.canon/CONVENTIONS.md` directly to add project conventions
- Suggest running `/canon:learn` after accumulating 10+ reviews to discover patterns and refine principles
- Suggest adding `.canon/` to git tracking if not already tracked
