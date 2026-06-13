---
id: source-shared-hook-helpers
title: Hooks Must Source Shared Helper Library for JSON Extraction
severity: convention
portable: false
scope:
  layers:
    - hooks
  file_patterns:
    - "hooks/**"
tags:
  - hooks
  - maintainability
  - deduplication
---

Hook scripts that parse Claude Code `tool_input` JSON MUST source `hooks/lib/canon-hook-lib.sh` and call `canon_extract_command` for command extraction. Inlining a copy of the extraction expression — even a byte-identical copy — is prohibited. The shared helper is the canonical location for the jq/grep-sed fallback logic; inlining it creates N independent copies that must each be hardened separately.

## Rationale

Before PR #270, three safety hooks — `destructive-guard.sh`, `pre-commit-check.sh`, and `workspace-lock-guard.sh` — each contained a verbatim copy of the same extraction expression:

```bash
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true)
```

When the expression was found to fail open on jq-absent environments, three files needed to be updated. The fix (PR #270) was forced to touch all three simultaneously. The root cause was not the expression itself — it was that the expression existed in three places, so a hardening fix had to be applied in triplicate.

`hooks/lib/canon-hook-lib.sh` centralizes this logic. When the library is hardened — whether to add a grep/sed fallback, improve jq error handling, or adjust field path priorities — every consumer gets the fix automatically. Inlined copies decay independently.

This is the shell-layer instance of the general principle: don't duplicate logic that needs to be maintained together. The extraction expression is not a one-liner that is obvious and stable — it has proven to require iteration. Central ownership is the correct pattern.

**What the shared library provides:**

- `canon_extract_command "$INPUT"` — extracts `.tool_input.command // .command` using jq when available; falls back to grep/sed for the simple string-typed field.
- `canon_git_dir_arg "$COMMAND"` — detects a `cd <dir> &&` prefix and returns `-C <dir>` for git commands.
- `canon_is_git_cmd "$COMMAND" "$SUBCMD"` — matches a git subcommand without false-positiving on filename arguments.

## Examples

**Bad — inlined extraction expression (pre-fix pattern, pre-PR #270):**

```bash
#!/usr/bin/env bash
INPUT=$(cat)

# Three separate hooks each contained this identical expression.
# When this expression needed hardening, all three had to be updated.
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true)

if [[ -z "$COMMAND" ]]; then
  exit 0
fi
```

**Good — source the shared library and use the named helper:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

INPUT=$(cat)
COMMAND=$(canon_extract_command "$INPUT")

if [[ -z "$COMMAND" ]]; then
  # ... two-stage empty check per hooks-fail-closed rule ...
  exit 0
fi
```

The `shellcheck source=` directive is required alongside every `source` call so shellcheck can resolve the path during static analysis. This is the convention in all updated hooks.

**Bad — using the library but re-implementing extraction:**

```bash
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

# Library sourced, but extraction inlined anyway — still violates this convention.
COMMAND=$(jq -r '.tool_input.command // empty' <<< "$INPUT" 2>/dev/null || true)
```

Even with the library sourced, calling `jq` directly instead of `canon_extract_command` bypasses the centralized logic and re-introduces the duplication problem.

## Exceptions

Hooks that do not parse Claude Code `tool_input` JSON — for example, hooks triggered by `SessionStart` or `PostCompact` that receive no JSON payload — have no obligation to source the library. If such a hook grows a JSON-parsing requirement, the convention applies from that point forward.

**Related:** `hooks-fail-closed` — the rule this convention enables: `canon_extract_command` provides the extraction; `hooks-fail-closed` governs what to do when extraction yields empty. `fail-closed-by-default` — the upstream rule that motivates correct extraction behavior for guard hooks.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's just one line — copy-paste is fine for something this small." | The expression has already proven to need iteration (PR #270 fixed it across 3 files simultaneously). Small does not mean stable. | Source the library. The change cost is one line. The maintenance benefit compounds across every future hardening. |
| "The library adds a dependency — what if it's not present?" | The library is part of the hooks directory. Its absence means the hooks directory is incomplete — a setup error that should be surfaced immediately, not silently worked around. | Source the library. If it is absent, the hook will fail on `source` and that failure is more informative than silent incorrect behavior. |
| "I tweaked the extraction slightly — it's not the same expression." | If your tweak is an improvement, it belongs in `canon-hook-lib.sh` where all consumers benefit. If it is hook-specific, the hook-specific adjustment belongs *after* calling `canon_extract_command`, not as a replacement for it. | Contribute the improvement to the shared library. Apply hook-specific adjustments as post-processing on the result. |

## Verification

- [ ] Every hook that reads `tool_input` JSON sources `hooks/lib/canon-hook-lib.sh` with a `# shellcheck source=` directive.
- [ ] No hook contains a `jq -r '.tool_input.command'` or `grep '"command"'` extraction expression outside of the shared library.
- [ ] New hooks that handle Bash `tool_input` payloads call `canon_extract_command` rather than inlining extraction.
