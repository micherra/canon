---
description: Quick inline check of principles relevant to current context
argument-hint: [file-path]
allowed-tools: [Read, Glob]
---

Quick inline check — loads principles relevant to the specified file (or current context) and displays them. No review, no diff analysis. Just "here are the principles that apply to what you're working on."

## Instructions

### Step 1: Determine context

If ${ARGUMENTS} contains a file path, use that file to determine context.

If no arguments provided, try to infer context from:
1. The most recently discussed or edited file in the conversation
2. If nothing available, show all `rule` severity principles

### Step 2: Find matching principles

Read all principle files from `.canon/principles/` (or fall back to `${CLAUDE_PLUGIN_ROOT}/principles/`).

For the target file, infer the architectural layer from its path:
- `*/api/*`, `*/routes/*`, `*/controllers/*` → `api`
- `*/components/*`, `*/pages/*`, `*/views/*` → `ui`
- `*/services/*`, `*/domain/*`, `*/models/*` → `domain`
- `*/db/*`, `*/data/*`, `*/repositories/*`, `*/prisma/*` → `data`
- `*/infra/*`, `*/deploy/*`, `*/terraform/*`, `*/docker/*` → `infra`
- `*/utils/*`, `*/lib/*`, `*/shared/*`, `*/types/*` → `shared`

A principle matches if:
- Its `scope.layers` is empty (universal), OR includes the inferred layer
- Its `scope.file_patterns` is empty, OR one of them glob-matches the file path

### Step 3: Display matched principle summaries

For each matched principle, show:
- The **id** and **title** from frontmatter
- The **severity** from frontmatter
- The **first paragraph** after frontmatter (the summary/constraint statement)

Sort by severity (rules first) and display as:

```
## Principles for [file-path]

### [rule] thin-handlers — Handlers Are Thin Orchestrators
HTTP handlers should do three things: validate input, call a service, and return a response. Business logic belongs in service modules, not handler files.

### [strong-opinion] errors-are-values — Errors Are Values, Not Surprises
Prefer returning typed result objects over throwing exceptions for expected failure cases.

---
N principles loaded (X rules, Y strong-opinions, Z conventions)
```

Keep the output scannable — show the constraint statement only, not the full rationale or examples. Users can read the full principle file if they need more detail.
