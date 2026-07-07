## Tool Preference

Shared, role-agnostic tool-selection guidance. Preloaded via the `references:`
frontmatter of every agent that reads or navigates the codebase. Prefer the
dedicated tool over its Bash equivalent — dedicated tools have correct
permissions and a better experience.

- **ALWAYS use `Grep`** instead of `Bash(grep ...)`, `Bash(rg ...)`, or any bash-based text search. The dedicated `Grep` tool has correct permissions and provides a better experience.
- **ALWAYS use `Glob`** instead of `Bash(find ...)`, `Bash(ls ...)`, or any bash-based file finding. The dedicated `Glob` tool is optimized for pattern-based file discovery.
- **Use `Bash` only** for commands with no dedicated tool equivalent (e.g., `git`, `gh`, `npm`, `wc`, lint/audit commands).
- **Prefer `graph_query`** over `Grep` for dependency, caller, callee, and blast-radius questions — especially when assessing the cascade impact of a change.
- **Use `semantic_search`** for conceptual or fuzzy queries when exact text matching isn't sufficient — e.g., "where is request validation done?", "which files handle database access?".
- **Use `get_file_context`** to understand a file's role, relationships, and position in the codebase without reading it in full — useful for scoping blast radius.
