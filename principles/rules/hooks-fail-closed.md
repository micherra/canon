---
id: hooks-fail-closed
title: Safety Hooks Must Fail Closed
severity: rule
scope:
  layers:
    - hooks
  file_patterns:
    - "hooks/**"
tags:
  - security
  - reliability
  - hooks
---

A hook that guards a destructive or security-sensitive operation MUST block (exit non-zero) whenever it cannot determine the command or its inputs. Fail-open behavior — allowing a Bash invocation to proceed when command extraction fails — must be an explicit, documented decision reserved for advisory-only hooks, never the implicit consequence of `2>/dev/null || true` or an empty-string check that silently passes.

## Rationale

Fail-open in a safety hook inverts the protection it provides. When `jq` is absent and the extraction expression silently yields an empty string, a check like `[[ -z "$COMMAND" ]] && exit 0` converts a parse failure into a pass — the exact opposite of what the hook is supposed to do.

This was the canonical incident for this principle: PR #270 (`fix(hooks): use jq for JSON extraction`) fixed `destructive-guard.sh`, `pre-commit-check.sh`, and `workspace-lock-guard.sh` after all three were discovered to fail open when `jq` was absent. Each hook inlined the jq expression without a fallback that could distinguish "no command field" from "extraction failed." A system without `jq` installed had effectively no destructive-git guard.

The risk is not theoretical. CI environments, stripped containers, and developer machines all vary in which tools are present. A hook that silently passes on a missing dependency is indistinguishable from a hook that never ran.

**Why `canon_extract_command` is the required pattern:** The shared helper in `hooks/lib/canon-hook-lib.sh` uses jq when available and falls back to grep/sed for the simple string-typed `command` field. Hooks then perform a second check: if the payload *contains* a `"command"` key but extraction still yields empty, that is a parse failure — block, do not pass. Only when the payload genuinely has no `command` field should a hook exit 0.

**Relation to `fail-closed-by-default`:** `hooks-fail-closed` operationalizes `fail-closed-by-default` for the shell hook layer. The parent rule addresses application-layer security checks (auth, rate limiting); this rule addresses the shell script guardrail layer where the same fail-open failure mode appears in a different form.

## Examples

**Bad — fail-open when jq is absent (pre-fix pattern from `destructive-guard.sh` before PR #270):**

```bash
# BEFORE (fail-open): jq absent → expression silently yields "" → exit 0 = ALLOW
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true)
if [[ -z "$COMMAND" ]]; then
  exit 0   # ← passes even when jq failed and extraction yielded nothing
fi
```

When `jq` is not installed, `2>/dev/null || true` produces an empty string. `$COMMAND` is empty. The hook exits 0 and allows every Bash invocation — including `git reset --hard`.

**Good — fail-closed via `canon_extract_command` with parse-failure distinction (post-fix pattern):**

```bash
# Source the shared helper (provides canon_extract_command).
# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

INPUT=$(cat)
COMMAND=$(canon_extract_command "$INPUT")

# Distinguish "no command field" from "extraction failed".
if [[ -z "$COMMAND" ]]; then
  if [[ -n "$INPUT" ]] && printf '%s' "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]'; then
    # Payload has a command key but extraction yielded empty → parse failure → BLOCK.
    echo "CANON: command extraction failed — blocking fail-closed." >&2
    exit 2
  fi
  # Payload has no command field (e.g. Write/Edit tool) → pass.
  exit 0
fi
```

The second-level check (`grep -qE '"command"...'`) catches the case where the payload contains a `command` key but extraction still failed. This preserves correct pass-through for Write/Edit tools (which have no `command` field) while blocking when extraction breaks on a Bash payload.

## Exceptions

Advisory-only hooks with a documented exit-0 contract may warn-and-pass on parse failure:

```bash
# Advisory hook (dag-dispatch-guard.sh) — exit 0 is the documented contract.
# Advisory hooks never block, so pass-through on parse failure is intentional.
# DOCUMENTED FAIL-OPEN: this hook is advisory only (exit 0 always).
if [[ -z "$COMMAND" ]]; then
  exit 0
fi
```

The exception requires an explicit `# DOCUMENTED FAIL-OPEN` comment naming the advisory contract. Absence of such a comment means the hook is subject to this rule.

**Related:** `fail-closed-by-default` — the application-layer equivalent this rule operationalizes for shell hooks. `source-shared-hook-helpers` — the convention that mandates using `canon_extract_command` rather than inlining extraction expressions.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "jq is always installed — this can't happen in practice." | jq availability varies across CI environments, containers, and developer machines. The hook must be correct regardless of what tools are present. | Block on extraction failure. The grep/sed fallback in `canon_extract_command` handles jq-absent environments; the second-level check handles the remaining ambiguity. |
| "Passing on empty command is correct — Write/Edit tools don't have a command field." | That reasoning applies when the payload has *no* command key. It does not apply when the payload *has* a command key but extraction yielded empty (parse failure). | Use the two-stage check: first test if command extraction yielded empty; then check if the payload contained a command key. Only exit 0 when the key is genuinely absent. |
| "Blocking on a parse failure is too strict — it will interrupt normal workflows." | A false block forces a re-run with correct tooling. A false pass silently bypasses the guard. The cost asymmetry is severe: an unnecessary block costs seconds; a missed guard allows irreversible data loss. | Block on parse failure. Fix the environment (install jq). |
| "The `|| true` at the end is just defensive coding." | `|| true` after a command substitution converts non-zero exit codes into empty strings and suppresses them. On a safety hook, this means a broken extraction produces an empty command and the guard silently passes everything. | Remove `|| true` from extraction expressions in safety hooks. Let extraction failure propagate. |

## Verification

- [ ] Every guard hook that calls `canon_extract_command` performs the two-stage empty check: (1) is the command empty? (2) if the payload contained a `"command"` key, block — do not exit 0.
- [ ] No guard hook has a bare `[[ -z "$COMMAND" ]] && exit 0` pattern after extraction without the second-stage payload check.
- [ ] Hooks that are intentionally advisory-only carry a `# DOCUMENTED FAIL-OPEN` comment; absent this comment, empty-extraction must block.
- [ ] Guard hooks source `hooks/lib/canon-hook-lib.sh` and use `canon_extract_command` rather than inlining jq expressions with `2>/dev/null || true`.
