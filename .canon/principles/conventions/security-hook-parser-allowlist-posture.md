---
id: security-hook-parser-allowlist-posture
title: Security-Control Hook Parsers Must Use Allowlist (Positive-Safety) Posture, Not Blocklist
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "hooks/**"
    - "**/hooks/**"
  tags:
    - security
    - hooks
    - safety
    - mechanical-checks
---

A hook parser that analyzes a command string to make a security-control decision (block / allow) MUST use an **allowlist (positive-safety) posture**: a wrapper, prefix, or command-word allowlist must FAIL CLOSED on an unrecognized leading token — never pass-through or ALLOW. It must NOT use a blocklist (negative-question) posture over substrings derived from a pre-expansion token.

The reason is structural: a PreToolUse hook receives the command string BEFORE the shell expands `$(...)` / `${VAR:-main}`. The hook cannot know what an unexpanded construct resolves to. Any enumerated-positive-set — a list of recognized wrappers, a list of known-bad flags, an exact-literal case arm — is always incomplete. The next variant the author did not enumerate slips through. An allowlist posture inverts this: any token that cannot pass a strict positive gate is not provably safe → block by default. The enumeration surface is eliminated rather than extended.

## The Rule

1. For each token that participates in the security decision, apply a single positive charset gate FIRST, before any substring derivation. A token that does not match a strict safe charset (e.g., `^[+]?[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._/-]*)?$` for a refspec) is NOT provably literal — fail closed without enumerating metacharacter types.
2. Only after a token passes the positive gate may you derive substrings (split on colon to extract a destination, strip a prefix) and compare against known-bad values.
3. When the safe charset cannot be statically defined (push-everything flags, option abbreviations git's parse-options layer accepts), test the token against a POSITIVE canonical-prefix regex (e.g., `^--a(l(l)?)?$` for the `--all` family) rather than an exact-literal case arm — block if the token COULD be the dangerous flag.
4. A wrapper / prefix / command-word resolver MUST treat an UNKNOWN leading word (not in the recognized set, not a known-safe terminal like `echo`/`printf`/`cat`) as opaque passthrough → scan all remaining clause tokens and fail closed if any resolves to the guarded command. It must NOT return ALLOW on first-unknown.
5. Flag-cluster parsing must model the real getopt semantics of value-consuming flags (match by the cluster's LAST char), not exact-token equality — otherwise `-nu ci` leaves the guarded command word unparsed.

## Rationale

Blocklist checks over derived substrings of pre-expansion tokens can be defeated by any unexpanded construct that steers the derivation: parameter operators containing colons (`HEAD:${BRANCH:-main}`), git option abbreviations not covered by the literal set (`--al`, `--mir`), config-driven push modes that bypass the refspec path entirely (`remote.*.push`), and command-executing wrappers absent from a recognized set (`setsid`, `xargs`, `ionice`, `sudo -nu`). Each patch to a blocklist closes one form and leaves the next variant open — observed across five builds and as many as eight fix rounds in one (`watch_UUUUUUUU2`).

The shared helper `canon_git_subcommand` in `hooks/lib/canon-hook-lib.sh` already uses a positive-safety allowlist at the subcommand level (validates the subcommand token against `^[A-Za-z][A-Za-z0-9_-]*$`, fails closed on anything else). That posture has never fail-opened. The recurring defect is when a sibling analysis path inside the same hook reverts to a blocklist or a closed enumerated set — a structural inconsistency within one guard.

## Examples

**Bad — recognized-wrapper closed allowlist returns ALLOW on first-unknown (PR #402 CRITICAL #1):**

```bash
# RECOGNIZED set: env/command/exec/nohup/nice/timeout/stdbuf.
# Walker returns ALLOW (exit 0) when the leading word is not recognized.
# setsid \git push origin main → 'setsid' unrecognized → exit 0 → BYPASS.
case "$word" in
  env|command|exec|nohup|nice|timeout|stdbuf) shift; continue ;;
  *) exit 0 ;;   # ← fail-OPEN on the first unrecognized wrapper
esac
```

**Good — unknown leading word is opaque passthrough → scan remaining tokens, fail closed:**

```bash
# Unknown word (not recognized, not a known-safe terminal): do not trust it.
# Scan all remaining clause tokens; any de-escaped 'git' → MATCH → BLOCK.
case "$word" in
  env|command|exec|nohup|nice|timeout|stdbuf) shift; continue ;;
  echo|printf|cat) exit 0 ;;            # known-safe terminals only
  *) if remaining_tokens_contain_git "$@"; then exit 2; fi ;;  # fail-CLOSED on unknown
esac
```

**Bad — blocklist over a derived substring of a pre-expansion refspec (PR #376 F2):**

```bash
# Extract the destination via last-colon split, then ask "is it main?".
# HEAD:${BRANCH:-main} → ##*: fires inside the :- operator; the blocklist
# never sees the $ or { → BYPASS.
dest="${refspec##*:}"
[[ "$dest" == "main" ]] && exit 2   # ← derivation defeated by unexpanded construct
```

**Good — positive charset gate on the whole refspec token before any derivation:**

```bash
# A refspec that contains any shell metacharacter is not provably literal → BLOCK.
SAFE_REFSPEC_RE='^[+]?[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._/-]*)?$'
[[ "$refspec" =~ $SAFE_REFSPEC_RE ]] || exit 2   # fail-closed on anything not provably inert
# Only now is it safe to split and compare against the protected branch.
```

## Reference Implementation

- `hooks/push-to-main-guard.sh` — `SAFE_REFSPEC_RE` positive gate on the full refspec token; `is_push_everything_mode()` canonical-prefix regex for the `--all`/`--mirror` family; unknown-leading-word opaque passthrough with fail-closed scan-forward; getopt-cluster last-char flag matching (DESIGN-v2, PRs #376/#386/#402).
- `hooks/lib/canon-hook-lib.sh:canon_git_subcommand` — subcommand-level positive charset gate (pre-existing, never fail-opened).

## Exceptions

**Advisory-only hooks** (exit 0 always, carrying a `# DOCUMENTED FAIL-OPEN` comment) are not subject to this constraint — they make no block/allow decision. See `hooks-fail-closed` exception clause.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "My recognized-wrapper list covers the wrappers that matter." | The list is always incomplete: `setsid`, `xargs`, `ionice`, `runuser`, `flock`, `taskset`, `caffeinate`, `watch` are all command-executing passthroughs. The next unlisted one is a bypass. | Treat unknown leading words as opaque passthrough → scan-forward → fail closed. |
| "Just add the missing wrapper to the list." | This is the Nth patch of the same enumeration-gap class. Each addition closes one form and opens the next. | Abandon enumeration for a fail-closed-on-unrecognized predicate (see `watch_UUUUUUUU2`). |
| "Exact-token matching of the flag is precise enough." | git's parse-options accepts unambiguous prefixes (`--al` for `--all`) and getopt clusters consume values (`-nu ci`). Exact-token matching misses both. | Use a positive canonical-prefix regex and model cluster last-char value consumption. |

## Reviewer Check

When a new or modified hook makes a block/allow decision over a command string: verify it does NOT (1) return ALLOW on an unrecognized leading wrapper/prefix/command word, (2) derive a substring from a pre-expansion token before applying a positive charset gate, or (3) rely on exact-literal flag matching where git accepts prefixes or getopt clusters. Any of these is the blocklist posture this convention forbids.

**See also:** `hooks-fail-closed` (rule) — this convention is a SHARPENING of that rule for the parser-posture dimension; the rule requires fail-closed behavior, this convention names the specific allowlist implementation that achieves it reliably over pre-expansion command strings. `source-shared-hook-helpers`, `scanner-avoids-its-own-pattern`, `fail-closed-scan-scope` — sibling hook conventions.

## Verification

- [ ] A wrapper / prefix / command-word resolver fails closed (scans remaining tokens for the guarded command) on an unrecognized leading word — it never returns ALLOW on first-unknown.
- [ ] Each security-relevant token passes a strict positive charset gate BEFORE any substring derivation.
- [ ] Dangerous flags are matched by positive canonical-prefix regex (not exact-literal case arms) and getopt clusters are parsed by last-char value-consumption semantics.
