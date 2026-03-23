---
template: context-sync-report
description: >-
  Standardized output for the canon-scribe agent. Records which files
  were classified, which documents were updated, and freshness stamps.
used-by: [canon-scribe]
read-by: [canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md
fields:
  status: "UPDATED | NO_UPDATES"
  agent: canon-scribe
  timestamp: ISO-8601
---

```markdown
---
status: "{UPDATED|NO_UPDATES}"
agent: canon-scribe
timestamp: "{ISO-8601}"
---

## Context Sync

### Changes Classified
| File | Category | Doc Updated |
|------|----------|-------------|
| `path/to/file` | contract | CLAUDE.md — Contracts |
| `path/to/other` | internal | — |

### Documents Updated
- **CLAUDE.md**: {sections updated, or "No updates needed"}
- **context.md**: {what changed, or "No updates needed"}
- **CONVENTIONS.md**: {what added, or "No updates needed"}

### Freshness
| Document | Section | Last Updated |
|----------|---------|--------------|
| CLAUDE.md | Contracts | YYYY-MM-DD |
```

## Rules

1. **One row per changed file** in the Changes Classified table. Every file from the git diff must appear.
2. **Category must be one of**: `contract`, `structure`, `dependency`, `invariant`, `internal`, `test-only`, `config`.
3. **Doc Updated column**: If the file's category triggered a doc update, name the document and section. Otherwise `—`.
4. **Documents Updated section**: List every managed document with what changed. If nothing changed, say "No updates needed" — never omit the line.
5. **Freshness table**: Only include documents/sections that were actually updated in this sync. Omit the table entirely if status is NO_UPDATES.
