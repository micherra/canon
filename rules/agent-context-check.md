---
id: agent-context-check
title: Verify Context Before Starting Work
severity: rule
tags: [agent-behavior, context, self-serve]
scope:
  agents: all
---

# Verify Context Before Starting Work

Before starting work, check your spawn prompt for context:

1. **Principles**: If your spawn prompt does not include a `## Principles` section, call `get_principles` with your target file path and task description.

2. **File context**: If you need dependency or graph information not in your prompt, call `get_file_context` or `graph_query` directly.

3. **Domain skills**: If your spawn prompt includes a `Relevant domain skills:` list, Read each named skill file from `references/` before starting work.

4. **Template**: If your spawn prompt names a template (e.g., `Use template: summary`), Read it from `templates/` before producing output.

5. **Retrieval strategy**: If your task involves searching the codebase, Read `primers/retrieval-strategy.md` for guidance on tool selection (Grep vs semantic_search vs graph_query). If you are running as a Sonnet or Haiku model, prefer Grep/Glob over semantic_search for identifier lookups.

Do not block or report an error if context is missing — self-serve it via MCP tools and Read.
