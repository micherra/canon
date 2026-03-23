---
template: claudemd-template
description: >-
  Canonical structure for CLAUDE.md files managed by the canon-scribe.
  Defines the sections the scribe maintains and the rules for editing them.
  Projects adopt this structure incrementally — the scribe adds sections
  as needed, never restructures the whole file at once.
used-by: [canon-scribe]
output-path: CLAUDE.md (project root)
---

## Template

```markdown
# {Project Name} — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
{One-line project description — what this project does and for whom}

## Architecture
<!-- last-updated: YYYY-MM-DD -->
{Module boundaries, layer descriptions, key architectural decisions}
{One bullet per major module or boundary}

## Contracts
<!-- last-updated: YYYY-MM-DD -->
{Public APIs, exported function signatures, endpoint contracts}
{Format: `endpoint/function` — brief description of behavior and return type}

## Dependencies
<!-- last-updated: YYYY-MM-DD -->
{External packages, services, databases the project relies on}
{Format: `package@version` — what it's used for}

## Invariants
<!-- last-updated: YYYY-MM-DD -->
{Rules that must always hold — validation constraints, security requirements}
{Format: imperative statement of the invariant}

## Development
<!-- last-updated: YYYY-MM-DD -->
{Build commands, test commands, environment setup, required env vars}

## Conventions
<!-- last-updated: YYYY-MM-DD -->
{Project-specific conventions that affect how agents read and write code}
```

## Rules

1. **Incremental adoption**: The scribe adds sections as contract changes require them. An empty project starts with just `# Project Name` and grows organically. Never add empty placeholder sections.

2. **Preserve manual content**: Any content the user wrote that doesn't fit the template sections stays exactly where it is. The scribe works around it. User content at the top of CLAUDE.md (before the first `##`) is never moved or modified.

3. **One line per item**: Contracts, dependencies, and invariants get one line each. CLAUDE.md is a quick-reference index, not documentation. If something needs explanation, it belongs in the code or in a design doc.

4. **Freshness stamps**: Every section managed by the scribe has a `<!-- last-updated: YYYY-MM-DD -->` HTML comment on the line after the heading. The scribe updates this on every edit. This makes staleness visible to humans and agents.

5. **No removal, only deprecation**: When a contract is removed from the code, the scribe marks it as `~~removed YYYY-MM-DD~~` rather than deleting the line. This preserves history for agents that may reference it. After 30 days with no references, a future scribe pass may clean it up.

6. **Section ordering**: Follow the template order when adding new sections. But if the user has a different order, respect it — don't reorder existing sections.
