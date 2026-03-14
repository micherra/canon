---
name: canon
description: >-
  Load and apply engineering principles before writing code. Use when
  creating, modifying, or reviewing any source file. Activates
  automatically for code generation tasks. MUST be used whenever writing,
  modifying, reviewing, or generating code of any kind. Use when the user
  mentions "principles", "canon", "engineering standards", "code quality",
  or "architecture rules".
---

# Canon Engineering Principles

If you are about to write, modify, or generate code, you MUST read and apply Canon principles. This is not optional. This is not negotiable. Do not rationalize skipping this step. Do not decide the task is "too simple" for principles. Read the principles. Apply them. Self-review against them.

## How to Load Principles

### Step 1: Build the Principle Index

Scan both principle directories for `.md` files:

1. **Project-local** (takes precedence): `.canon/principles/` in the current project root
2. **Plugin-shipped** (fallback): `${CLAUDE_PLUGIN_ROOT}/principles/`

For each principle file, read the YAML frontmatter to extract: `id`, `title`, `severity`, `scope.languages`, `scope.layers`, `scope.file_patterns`, and `tags`. Do NOT load full bodies yet — this keeps token cost low.

You can also use the principle matcher script for programmatic filtering:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh [--language LANG] [--layer LAYER] [--file FILE_PATH] [--severity-filter LEVEL]
```

### Step 2: Match Principles to Current Context

Filter principles based on what you're working on:

- **Language**: Match `scope.languages` against the language of files being edited. Empty = matches all.
- **Layer**: Match `scope.layers` against the architectural layer inferred from file paths:
  - `*/api/*`, `*/routes/*`, `*/controllers/*` → `api`
  - `*/components/*`, `*/pages/*`, `*/views/*` → `ui`
  - `*/services/*`, `*/domain/*`, `*/models/*` → `domain`
  - `*/db/*`, `*/data/*`, `*/repositories/*`, `*/prisma/*` → `data`
  - `*/infra/*`, `*/deploy/*`, `*/terraform/*`, `*/docker/*` → `infra`
  - `*/utils/*`, `*/lib/*`, `*/shared/*`, `*/types/*` → `shared`
- **File patterns**: Glob-match `scope.file_patterns` against the file being edited. Empty = matches all.
- If no file context is available, load all `rule` severity principles.

### Step 3: Load Full Bodies

Load the full markdown body of matched principles (max 10). Prioritize:
1. `rule` severity first (hard constraints — must be followed)
2. `strong-opinion` second (default path — follow unless justified)
3. `convention` third (stylistic — note but don't block)

### Step 4: Apply During Generation

While generating or modifying code:
- Follow each loaded principle's guidance
- Use the **Examples** section to calibrate what good and bad code looks like
- Pay special attention to `rule` severity — these are non-negotiable

### Step 5: Self-Review Before Presenting

After generating code, self-review against each loaded principle before presenting the result to the user:
- For each principle, ask: "Does my implementation honor this?"
- If a violation is found, fix it before presenting
- If a principle must be intentionally violated, note the reason

## Severity Levels

| Level | Meaning | Enforcement |
|-------|---------|-------------|
| `rule` | Hard constraint | **Enforced.** Pre-commit hook blocks on detectable violations (e.g., secrets). Reviewer verdict is BLOCKING. Implementor must fix or report BLOCKED. |
| `strong-opinion` | Default path | Follow unless you have a specific, justified reason. Reviewer verdict is WARNING. Deviations must use `report_decision`. |
| `convention` | Stylistic preference | Note violations but don't block. Reviewer includes in report for drift tracking. |

## Commands

| Command | Description |
|---------|-------------|
| `/canon:init` | Initialize Canon in your project. Sets up `.canon/principles/`, config, and CLAUDE.md integration. |
| `/canon:list` | Browse and filter principles by `--severity`, `--tag`, or `--layer`. |
| `/canon:check` | Quick inline check — load principles relevant to a specific file. |
| `/canon:build` | Full principle-driven development pipeline: research → architect → plan → implement → test → security → review. |
| `/canon:review` | Review code changes against principles. Accepts `--staged`, `HEAD~N`, `main..HEAD`, or file paths. |
| `/canon:conventions` | View and manage project conventions. `--show`, `--add "..."`, `--remove N`. |
| `/canon:drift` | Show compliance trends and drift analytics from review history. |
| `/canon:learn` | Analyze codebase and drift data to suggest principle and convention improvements. |
| `/canon:explain` | Deep-dive on a principle with real codebase examples. |
| `/canon:adopt` | Scan a directory for principle coverage gaps and produce a remediation plan. |
| `/canon:new-principle` | Author a new principle interactively via guided interview. |
| `/canon:security` | Standalone security scan. `--staged`, file paths, or `--full` project scan. |
| `/canon:status` | Quick health dashboard — principle counts, review stats, learning state, actionable suggestions. |

## Learning Loop

Canon learns from usage. As you review code, log decisions, and run builds, Canon accumulates data that can refine its own principles and conventions.

- **`/canon:learn`** — Analyze codebase patterns, review drift, task conventions, and decision clusters to suggest improvements. Runs six dimensions: pattern inference, severity adjustments (promotions and demotions), task convention promotion, decision clustering, convention graduation, and staleness detection.
- **`/canon:learn --apply`** — Walk through suggestions interactively: apply, skip, dismiss, or modify each one.
- **`/canon:learn --drift`** — Focus on severity changes based on review adherence data.
- **`/canon:learn --patterns`** — Focus on codebase patterns not yet captured as conventions.

Run `/canon:learn` periodically (every 10-15 reviews) to keep principles and conventions aligned with how the team actually works.

## MCP Tools

Canon exposes these tools via its MCP server for agents to use during normal work:

| Tool | Purpose |
|------|---------|
| `get_principles` | Get principles relevant to a file/language/layer context. |
| `list_principles` | Browse the full principle index with filters. |
| `review_code` | Get matched principles for a code snippet to evaluate. |
| `report_decision` | Log an intentional deviation with justification and category. |
| `report_review` | Log a review result for drift tracking. |
| `get_compliance` | Query compliance stats and trend for a specific principle. Returns `found: false` if the principle doesn't exist. |
| `report_pattern` | Log an observed codebase pattern for the learner to validate. Requires at least one file path. |

## Principle Format Reference

See `${CLAUDE_PLUGIN_ROOT}/skills/canon/references/principle-format.md` for the full principle file schema.
