---
description: Initialize Canon principles in your project
argument-hint: [--starter|--empty|--no-scan]
allowed-tools: [Bash, Read, Write, Glob, Edit, Agent]
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
  "principle_dirs": [".canon/principles"],
  "layers": {
    "src": ["src/**"]
  },
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

Check if `CLAUDE.md` exists in the project root. If it does, check whether it already contains a "Canon" section. If not, append the following sections:

```markdown

## Canon Orchestration (MANDATORY)

This project has Canon initialized. **You ARE the orchestrator.** Drive the build pipeline yourself using Canon's MCP harness tools — do NOT spawn a canon-orchestrator subagent. Call MCP tools directly and spawn only specialist agents as leaf workers.

Classify every user message by intent:
- **build/review/security** → Load flow with `load_flow`, init workspace with `init_workspace`, drive the state machine by calling `drive_flow` → process `SpawnRequest`/`HitlBreakpoint` → spawn specialist agent → `report_result`. Read `agents/canon-orchestrator.md` for the full protocol.
- **question/status** → Spawn `canon:canon-guide`
- **principle authoring** → Spawn `canon:canon-writer`
- **learn** → Spawn `canon:canon-learner`
- **git ops / read-only / chat** → Handle directly

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Principles are in `.canon/principles/`. Severity levels: `rule` is non-negotiable, `strong-opinion` requires justification to skip, `convention` is noted but doesn't block.
```

If `CLAUDE.md` doesn't exist, create it with just the Canon sections above.

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

Tell the user what was created (principles, conventions, workspaces, CLAUDE.md). If the adoption scan in Step 7 was run, summarize scan results here (number of violations found by tier, and whether any were highlighted for attention). Suggest next steps: ask Canon to list principles to browse them, edit `.canon/CONVENTIONS.md` to add conventions, and add `.canon/` to git tracking.

### Step 7: Run adoption scan

Check whether `--no-scan` was passed in `${ARGUMENTS}`. If it was, skip this step entirely.

Otherwise, invoke the orchestrator with:
- `flow: adopt`
- `task: "Adoption scan of the project"`

The flow will scan the codebase for principle violations and produce a tiered adoption report. Read the adoption report from the workspace and display a summary to the user: how many violations were found per tier, and which files have the most issues.

If the project appears to be empty or very small (fewer than 5 source files), skip the scan and note that it can be run later by re-running `/canon:init` without `--no-scan`.
