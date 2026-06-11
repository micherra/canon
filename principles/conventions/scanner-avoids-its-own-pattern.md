---
id: scanner-avoids-its-own-pattern
title: A Scanner Must Not Contain the Literal Pattern It Detects
severity: convention
scope:
  layers:
    - hooks
  file_patterns:
    - "hooks/**"
    - "scripts/**"
    - "agents/*.md"
    - "rules/*.md"
    - "references/*.md"
tags:
  - hooks
  - verification
  - mechanical-checks
  - safety
---

A tool — hook, script, grep command, or verification step — that is designed to detect string pattern S must not contain S verbatim in an executable or intercepted position. When a pre-tool-use hook intercepts all Bash commands and pattern-matches on the command string, a grep or script that contains the literal form of S becomes indistinguishable from an instance of the defect being checked. The detection layer fires on the scanner itself.

**Resolution options (choose one):**

1. **Character-class split**: express the two-token pattern via a regex that matches it without reproducing it literally. For `bash -c` and `sh -c`: use `(ba)?sh[[:space:]]+-c` (requires `-E` for ERE — without `-E` the plain `grep` BRE engine silently matches nothing, which is the false-negative this convention warns against).
2. **Token break**: concatenate parts of the pattern at execution time, or split across two grep passes.
3. **Indirect variable**: assign the full pattern to a variable, then interpolate: `PAT='bash -c'; grep -n "$PAT" file.sh` — the literal form never appears in the source text the hook scans. **Caution**: the variable must contain the entire pattern; any `|` character remaining outside the variable will cause the guard to segment the command and may trigger a false-positive (see pitfall in the Why section).
4. **Out-of-band invocation**: use a temp wrapper script that `source`s the target instead of invoking it via the pattern (e.g., `source "$script_path" "$@"` instead of the string-executing form).

## Why

Pre-tool-use hooks operate on the raw command string before it executes. The quote-aware tokenizer in `destructive-guard.sh` (`canon_tokenize` / `canon_unwrap_string_exec_arg` in `hooks/lib/canon-hook-lib.sh`) decides whether a command segment contains a string-executing wrapper by examining individual tokens.

This tokenizer behavior has a nuanced implication for verification greps:

- **Single-quoted single-token forms pass through**: `grep 'bash -c' file.sh` — the tokenizer collapses the quoted span `'bash -c'` into one token (`bash -c`), which does NOT equal the bare `bash` command token. The scan-forward walks past it. Exit 0.
- **Backslash-bearing alternation inside double quotes blocks**: `grep -n "bash -c\|sh -c" file.sh` — the `\|` sequence inside the double-quoted span leaves a backslash artifact that the tokenizer cannot decode. This is the string-executing-wrapper detection path failing with "unparseable inner command" → fail-closed. Exit 2.

The second form is the **recurring false-positive**: authors write it as a convenient two-pattern alternation grep, not realizing the backslash inside the double-quoted span makes the command string undecodable by the tokenizer. The fail-closed outcome is correct behavior per `hooks-fail-closed` — the hook cannot tell whether the argument is a verification grep or a genuine destructive wrapper call. The constraint falls on the author: avoid the backslash-alternation form inside double quotes.

Preferred alternatives: the **indirect-variable form** assigns the full pattern (including the space and flags) to a variable so the literal never appears in source text; the **character-class split** expresses the same match without any backslash inside a quoted span. Both exit 0.

**Pitfall — indirect variable with `|` in the grep alternation**: assigning only the token (`PAT='bash'`) and then writing `grep -E "$PAT -c|sh -c" file.sh` does NOT work. The `|` character is outside the quoted variable expansion; when the guard segments on `|`, it splits the command string into `grep -E "$PAT -c"` and `sh -c file.sh` — and `sh -c file.sh` is a string-executing wrapper → fail-closed (exit 2). The indirect variable must contain the whole pattern, or no `|` must appear after expansion. Use `PAT='bash -c'; grep -n "$PAT" file.sh` (single pattern, no alternation) or the character-class split for multi-pattern matching.

The same constraint applies when authoring mine scripts and code-analysis tools. A script designed to surface the `eval`/string-executing-wrapper defect class must not itself contain the defect it is designed to find, both for correctness and to avoid being blocked by the guard it is co-deployed with.

## Examples

### Verification grep for string-executing wrappers

**Passes — single-quoted single-token form (the tokenizer collapses the quoted span to one token):**

```bash
# grep 'bash -c' file.sh exits 0 — 'bash -c' is one token, not a bare bash command.
# Safe for use in verification greps.
grep 'bash -c' file.sh
```

**Bad — backslash-bearing alternation inside double quotes fails closed:**

```bash
# This grep is intended to check for both 'bash -c' and 'sh -c'.
# But the \| inside the double-quoted span is a backslash artifact
# the tokenizer cannot decode, so the hook fails closed (exit 2).
grep -n "bash -c\|sh -c" file.sh
```

**Good — indirect variable (preferred): the literal form never appears in source text:**

```bash
# Assign the full pattern (including space and flag) to a variable.
# The literal 'bash -c' is never in source text, and no '|' follows the expansion.
# Empirically verified exit 0 through destructive-guard.sh.
PAT='bash -c'; grep -n "$PAT" file.sh
```

> **Why not** `PAT='bash'; grep -E "$PAT -c|sh -c" file.sh`? The `|` outside the variable is still present in the command string. The guard segments on `|` and sees `sh -c file.sh` as a string-executing wrapper → fail-closed (exit 2). The indirect variable only helps if the full pattern is captured and no bare `|` remains.

**Good — character-class split: matches the pattern without the backslash-alternation form:**

```bash
# Matches 'bash -c' and 'sh -c' without containing the literal form or
# a backslash inside a double-quoted span.
# -E is required: this uses ERE syntax; without it, plain grep (BRE) silently
# matches nothing — a false-negative that defeats the purpose of the check.
# Empirically verified exit 0 through destructive-guard.sh.
grep -rnE '(ba)?sh[[:space:]]+-c' hooks/
```

### Parallel fan-out script that scans for a defect class

**Bad — script invokes a worker via the string-executing form:**

```bash
# The mine script is designed to detect shell-executing wrapper usage.
# Using the wrapper form in the mine script itself triggers the guard
# and also embeds the defect the script is designed to detect.
export -f process_item
xargs -P 8 -I{} bash -c 'process_item "$@"' _ {}
```

**Good — temp-wrapper approach using source instead:**

```bash
# Write a temp wrapper that sources this script and calls the function.
# No string-executing form appears in the mine script.
WRAPPER=$(mktemp /tmp/mine-worker-XXXXXX.sh)
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
source "$MINE_SCRIPT_PATH"
process_item "$@"
EOF
chmod +x "$WRAPPER"
export MINE_SCRIPT_PATH="$0"
xargs -P 8 -I{} "$WRAPPER" {}
rm -f "$WRAPPER"
```

### Indirect variable for a single-token pattern

**Bad — literal `eval` in the grep argument:**

```bash
grep -rn 'eval ' src/
```

**Good — token-split so the literal form never appears as a contiguous string in source text:**

```bash
# Split the blocked token across two variables so 'eval' never appears verbatim.
# P1='ev'; P2='al' → "${P1}${P2}" expands to 'eval' at runtime but the
# contiguous string is absent from the command source the hook scans.
# Empirically verified: matches 'eval ' in target files (exit 0) and
# grep for the literal token in this command's own source finds nothing (exit 1).
# Verified exit 0 through destructive-guard.sh.
P1='ev'; P2='al'; grep -rn "${P1}${P2} " src/
```

## Evidence

| # | Build | Scanner | Self-blocking form | Resolution |
|---|-------|---------|-------------------|------------|
| 1a | PR #355 (engineer) | `destructive-guard.sh` | `bash -c "$wrapper"` in xargs fan-out in mine script | Temp wrapper using `source` instead of the string-executing form |
| 1b | PR #355 (learner) | `destructive-guard.sh` | `grep -n "bash -c\|sh -c"` — backslash alternation in double-quoted span → fail-closed (exit 2) | Indirect variable: `PAT='bash -c'; grep -n "$PAT" file.sh` — full pattern in variable, no bare `\|` remaining (earlier `PAT='bash'; grep -E "$PAT -c\|sh -c"` was itself blocked — see pitfall in Why section) |
| 2 | PR #337 fix | `destructive-guard.sh` | Verification greps for `eval`/the two-token form in target files using backslash alternation | Pattern split via `grep -rnE '(ba)?sh[[:space:]]+-c'` (ERE, `-E` required) and token-split for `eval` |

## Exceptions

**Documented test fixtures**: A test file that intentionally contains the literal form as a fixture to verify the hook fires correctly is exempt, provided it carries a comment like `# fixture: intentional blocked pattern for hook test`. The file must not be executed in a context where the hook intercepts it.

**Out-of-scope hooks**: Hooks whose detection layer does not pattern-match on the command string as a whole (e.g., hooks that operate on structured JSON fields) are not subject to this constraint for string contents of those fields. The constraint applies wherever the detection layer intercepts raw command text.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's just a grep argument — the hook shouldn't fire on arguments." | The hook fires on the entire command string, including arguments. This is correct fail-closed behavior. The grep author must account for it. | Use a character-class split or indirect variable. |
| "The character-class form is harder to read." | A slightly less readable regex is preferable to a verification command that is blocked by the hook it coexists with. | Add a comment explaining the form: `# character-class split avoids literal form triggering the hook`. |
| "I'll just exempt my grep from the hook." | Blanket exemptions widen the bypass surface and defeat the purpose of the guard. Exemptions are for exceptional cases with documented justification, not routine verification commands. | Use the character-class or indirect variable form. |

## Reviewer Check

When a new hook, script, or verification grep is added that detects pattern S (especially `eval`, `git reset --hard`, `git push --force`, or any other Canon-guarded token): check whether the script itself could trigger the detection layer for S. If it could, verify that one of the resolution approaches (character-class, token break, indirect variable, temp wrapper) is in use.

**See also:** `hooks-fail-closed` (rule) — the principle that makes fail-closed interception correct behavior and therefore makes this constraint unavoidable. `verification-grep-minimum-scope` (convention) — the complementary constraint on grep pattern specificity. `watch_QQQQQQ1` — the promoted convention covering the class of "a remediation that contains the defect it was designed to prevent."

## Verification

- [ ] New hooks or scripts that scan for pattern S do not contain S verbatim in an executable or intercepted position.
- [ ] New verification greps in agent files, rules, and references that scan for Canon-guarded patterns (`eval`, string-executing wrappers, destructive git ops) use character-class or indirect-variable forms.
- [ ] Any literal-pattern form found during review is accompanied by a test-fixture comment or a documented hook-exemption justification.
