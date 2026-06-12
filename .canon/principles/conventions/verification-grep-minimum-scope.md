---
id: verification-grep-minimum-scope
title: Verification Greps Use Minimum-Sufficient Scope
severity: convention
scope:
  file_patterns:
    - "agents/*.md"
    - "rules/*.md"
    - "references/*.md"
    - "templates/*.md"
    - "CLAUDE.md"
    - "**/CLAUDE.md"
    - "principles/**"
tags:
  - verification
  - mechanical-checks
  - protocol
---

When a grep or awk command verifies a structural claim — frontmatter field presence, server registration, or config entry existence — the pattern AND path scope must be the minimum sufficient to confirm that claim. A match from prose, doc comments, or a neighboring frontmatter field does not satisfy a structural claim.

## Two Claim Types and Their Correct Forms

### Frontmatter field presence — block-extraction

When verifying that a value appears inside a specific frontmatter block (e.g., that a tool name appears in the `tools:` list of an agent file), the correct form isolates the target block and terminates at the next top-level key (column-0 character):

```
awk '/^tools:/{in_tools=1; next} in_tools && /^[^ \t]/{exit} in_tools{print}' agents/<agent>.md | grep '  - mcp__canon__<tool_name>$'
```

**Insufficient forms and why they fail:**

- **Bare `grep`**: matches occurrences in `description:`, `name:`, or body prose — any line in the file that mentions the tool name produces a false positive.
- **Line-number-before-`---`**: matches `description:` and every other frontmatter field — not scoped to the target block.
- **`in_tools && /^---/{exit}` terminator**: assumes `tools:` is the final frontmatter key. When `skills:`, `memory:`, or `description:` appears after `tools:`, those keys' content leaks through and produces false positives. This form passed PR #334's abstract review and was caught only by a concrete counterexample probe.

The `/^[^ \t]/{exit}` form is robust: any column-0 character — whether another frontmatter key or the closing `---` — terminates the scan.

### Code registration — quoted-string grep scoped to registration files

When verifying that a tool is registered in the MCP server, the correct form:

```
grep -rn '"<tool_name>"' mcp-server/src/app/register-*.ts
```

A match in a doc comment, variable name, JSDoc string, or non-registration file does NOT satisfy a registration claim. A bare `grep -r '<tool_name>' mcp-server/src/app/` will match prose mentions and produce false positives.

## Examples

### Frontmatter block-extraction

**Bad** — bare grep matches body prose and any other frontmatter field:
```example
grep 'mcp__canon__wiki_lint' agents/engineer.md
```

**Good** — block-extraction terminates at the next top-level key:
```
awk '/^tools:/{in_tools=1; next} in_tools && /^[^ \t]/{exit} in_tools{print}' agents/engineer.md | grep '  - mcp__canon__wiki_lint$'
```

### Code registration grep

**Bad** — directory-wide bare-string search matches doc comments:
```example
grep -r 'wiki_lint' mcp-server/src/app/
```

**Good** — quoted-string form scoped to registration files:
```
grep -rn '"wiki_lint"' mcp-server/src/app/register-*.ts
```

## Rationale

Two consecutive builds (PR #328 round 1 and the Codex fix-round) shipped overmatching greps that passed internal review because the pattern was never tested against a concrete counterexample. Both greps confirmed the structural claim when run against a synthetic, isolated context — and both failed against the real execution context, where prose, doc comments, or adjacent frontmatter fields satisfied the pattern and allowed a dead-wire defect to pass undetected.

## Enforcement

Enforcement lives in the reviewer's Stage 2 "Structural Assertion Grep Scope" sub-axis (`agents/reviewer.md`) and the writer's pre-commit counterexample-probe checklist. This convention is the citable statement of the pattern — cross-reference it when raising or discussing findings that fall under this category.
