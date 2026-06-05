---
template: context-sync
description: >-
  Standardized output for the scribe agent. Records which files
  were classified, which documents were updated, and freshness stamps.
used-by: [scribe]
read-by: [shipper]
output-path: ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md
fields:
  status: "UPDATED | NO_UPDATES"
  agent: scribe
  timestamp: ISO-8601
  context-budget: "per-file advisory size status for CLAUDE.md files touched (report-don't-trim)"
---

```markdown
---
status: "{UPDATED|NO_UPDATES}"
agent: scribe
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
- **README.md**: {sections updated, or "No updates needed" or "Skipped — no structure changes"}

### Direction-Doc Disposition
| Direction doc | Disposition | Detail |
|---------------|-------------|--------|
| `docs/{name}.md` | factual-update | {what fact was synced — status flip, PR ref, checkmark, renamed path} |
| `docs/{name}.md` | left-untouched | {drift observed but deliberately not edited — editorial/uncertain — with reason} |
| `docs/{name}.md` | not-relevant | Diff did not touch this doc's domain |

### Context Budget (advisory only)
| File | Status | Action Taken |
|------|--------|--------------|
| `path/to/CLAUDE.md` | Looks oversized (≈NN,NNN chars) | Advisory: dedicated trim build recommended; not trimmed this sync. |
| `path/to/other/CLAUDE.md` | Within budget — no action | — |

_If no CLAUDE.md files were touched, write "No CLAUDE.md files updated this sync." If all files looked fine, write "All files within budget — no advisory." The scribe never trims; this section only records advisory size status._

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
6. **Context Budget table (advisory only)**: Always include this section when any CLAUDE.md file was touched. One row per file touched. If no CLAUDE.md files were touched, write "No CLAUDE.md files updated this sync." This section records advisory size status only — the scribe never trims. If a file looks oversized, mark status as "Looks oversized (≈NN,NNN chars)" and note in Action Taken that a dedicated trim build is recommended and the file was not trimmed this sync. This is a heads-up for a future build, not a warning about a failure or an enforced limit.
7. **Direction-Doc Disposition**: List every top-level `docs/*.md` direction doc (excluding `docs/reference/`). For each, give a disposition: `factual-update` (you synced a fact), `left-untouched` (drift observed but deliberately not edited — always state the reason, especially editorial-prose drift), or `not-relevant` (diff did not touch its domain). Omit the section entirely only when status is NO_UPDATES.
