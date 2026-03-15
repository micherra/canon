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

If you are about to write, modify, or generate code, you MUST load and apply Canon principles.

## How to Load Principles

Use the `get_principles` MCP tool with the file path you're working on. It returns matched principles sorted by severity (rules first, then strong-opinions, then conventions), capped at 10.

If the MCP tool is unavailable, scan `.canon/principles/` (project-local, takes precedence) and `${CLAUDE_PLUGIN_ROOT}/principles/` (fallback) for `.md` files in `rules/`, `strong-opinions/`, and `conventions/` subdirectories. Match against file path and architectural layer.

## Apply During Generation

- Follow each loaded principle's guidance
- Use the **Examples** section to calibrate good vs bad code
- `rule` severity is non-negotiable; `strong-opinion` requires justification to skip; `convention` is noted but doesn't block

## Self-Review Before Presenting

After generating code, check each loaded principle: "Does my implementation honor this?" Fix violations before presenting. If intentionally violating a principle, note the reason.

## Principle Format Reference

See `${CLAUDE_PLUGIN_ROOT}/skills/canon/references/principle-format.md` for the full principle file schema.
