# Loading Canon Principles

This is the canonical process for loading Canon principles. All agents follow this protocol.

## Scoped Loading (for agents working on specific files)

Use the `get_principles` MCP tool with the file paths you'll read or modify. This returns only principles whose scope matches those files, respects the project's principle cap, and filters out archived principles.

- Use `summary_only: true` when you need the constraint statement but not the full rationale (implementation, testing, refactoring)
- Use full body (no `summary_only`) when you need examples and exceptions (design, review, security scanning)
- If the tool returns too many, cap at **10 principles** per agent spawn. Priority: rules > strong-opinions > conventions.

## Full Index (for agents scanning broadly)

Use the `list_principles` MCP tool to get the metadata-only index (id, title, severity, scope, tags). This avoids loading full bodies into context. Use this when you need to survey all principles without reading their content — e.g., conflict checking, learner baseline, writer dedup.

## Filesystem Fallback

If MCP tools are unavailable or fail:

1. Glob `.canon/principles/**/*.md` (project-local principles take precedence)
2. Then glob `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md` (built-in principles)
3. Read only the YAML frontmatter of each file for the index
4. Read full body only for principles you need to apply

Principles are organized into severity subdirectories: `rules/`, `strong-opinions/`, `conventions/`.

## When Everything Fails

If both MCP tools and filesystem globbing fail to return any principles, report `NEEDS_CONTEXT` with detail: "Unable to load Canon principles — MCP tools unavailable and no principle files found on disk."
