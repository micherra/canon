---
id: security-hook-parser-allowlist-posture
title: Safety Classifiers Must Use Allowlist (Positive-Safety) Posture, Not Denylist
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "hooks/**"
    - "**/hooks/**"
    - "scripts/**"
    - "**/scripts/**"
  tags:
    - security
    - hooks
    - safety
    - mechanical-checks
---

Any classifier in `hooks/**` or `scripts/**` that emits a SAFE-vs-UNSAFE or WIRED-vs-DEAD style verdict MUST use an **allowlist (positive-safety) posture**: the default verdict when a form is unrecognized is the SAFE/BLOCKED outcome — never ALLOW/PASS-THROUGH. It must NOT use a denylist (negative-question) posture that enumerates known-bad forms and passes everything else.

The reason is structural: a denylist is always incomplete. Each new form the author forgot to enumerate slips through undetected. An allowlist inverts this: any form that cannot pass a strict positive gate is not provably safe → fail closed by default. The enumeration surface is eliminated rather than extended. This applies equally to shell-command parsers that check pre-expansion tokens and to static-analysis scripts that classify source-code constructs.

## The Rule

**General posture requirement (applies to all safety classifiers):**

1. A classifier that decides a verdict by EXCLUDING known-bad forms (a denylist) fails OPEN on any form it forgot — each new excluded form closes one bypass and opens the next unlisted one (the treadmill). Do not build denylists.
2. Invert to an ALLOWLIST of known-good forms whose DEFAULT is the SAFE/BLOCKED verdict, so incompleteness fails CLOSED. A forgotten form over-flags (false positive), not under-flags (bypass).
3. Where a real AUTHORITY for the classification exists — a type-checker, a compiler, a declarative registry — DELEGATE to it rather than re-deriving the verdict syntactically. The authority is correct by construction; a hand-rolled syntactic approximation is not.

**Shell-command parser specifics (for PreToolUse hooks over raw command strings):**

4. For each token that participates in the security decision, apply a single positive charset gate FIRST, before any substring derivation. A token that does not match a strict safe charset (e.g., `^[+]?[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._/-]*)?$` for a refspec) is NOT provably literal — fail closed without enumerating metacharacter types.
5. Only after a token passes the positive gate may you derive substrings (split on colon to extract a destination, strip a prefix) and compare against known-bad values.
6. When the safe charset cannot be statically defined (push-everything flags, option abbreviations git's parse-options layer accepts), test the token against a POSITIVE canonical-prefix regex (e.g., `^--a(l(l)?)?$` for the `--all` family) rather than an exact-literal case arm — block if the token COULD be the dangerous flag.
7. A wrapper / prefix / command-word resolver MUST treat an UNKNOWN leading word (not in the recognized set, not a known-safe terminal like `echo`/`printf`/`cat`) as opaque passthrough → scan all remaining clause tokens and fail closed if any resolves to the guarded command. It must NOT return ALLOW on first-unknown.
8. Flag-cluster parsing must model the real getopt semantics of value-consuming flags (match by the cluster's LAST char), not exact-token equality — otherwise `-nu ci` leaves the guarded command word unparsed.

## Rationale

The denylist treadmill is a recurring defect class: each patch closes one known-bad form and leaves the next unlisted one open. Observed across five builds with as many as eight fix rounds in a single hook (`watch_UUUUUUUU2`). The same structural failure applies across two distinct classifier domains:

**Shell-command parsers (security hooks):** Blocklist checks over derived substrings of pre-expansion tokens can be defeated by any unexpanded construct that steers the derivation: parameter operators containing colons (`HEAD:${BRANCH:-main}`), git option abbreviations not covered by the literal set (`--al`, `--mir`), config-driven push modes that bypass the refspec path entirely (`remote.*.push`), and command-executing wrappers absent from a recognized set (`setsid`, `xargs`, `ionice`, `sudo -nu`).

**Static-analysis classifiers (dead-wire gate, reachability scripts):** A regex-based or AST-name-based denylist over source text cannot correctly identify whether a TypeScript symbol is a reachable export or a dead wire. The progression in `hooks/dead-wire-gate.sh` illustrates the full treadmill across four generations:

1. **Generation 1 — regex comment-strip denylist**: stripped comment lines, then scanned remaining text for known-bad patterns. Defeated by symbols declared in ways the regex didn't strip (multi-line exports, decorators, re-exports).
2. **Generation 2 — declaration-name denylist**: matched exported symbol names against a list of known-dead names. Each new dead wire required a manual list update; any name not on the list bypassed the gate.
3. **Generation 3 — use-position allowlist (hand-rolled)**: looked for call-sites in source text matching a positive pattern. Better direction, but the syntactic approximation over-admitted (string literals, type positions, commented-out code all matched) and under-admitted (indirect calls, re-exports did not).
4. **Generation 4 — TypeScript compiler-API binding resolution (PR #415)**: delegates to `tsc`'s type-checker. A symbol is WIRED if and only if the compiler's binding graph has at least one real reference at a value-position. The type-checker is the authority — correct by construction, no hand-rolled approximation.

The shared helper `canon_git_subcommand` in `hooks/lib/canon-hook-lib.sh` has always used a positive-safety allowlist at the subcommand level (validates the subcommand token against `^[A-Za-z][A-Za-z0-9_-]*$`, fails closed on anything else). That posture has never fail-opened. The recurring defect is when a sibling analysis path inside the same hook reverts to a denylist or a closed enumerated set — a structural inconsistency within one guard.

## Examples

### Shell-command parser examples (security hooks)

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

### Static-analysis classifier example (dead-wire gate)

**Bad — denylist-based generation (Generations 1–2, defeated by omission):**

```bash
# Strip comments, then check if the export name is in a known-dead list.
# A new dead wire not on the list → PASSES = BYPASS.
KNOWN_DEAD="oldTool|deprecatedHelper|unusedExport"
if echo "$export_name" | grep -qE "^($KNOWN_DEAD)$"; then
  echo "DEAD: $export_name" && exit 1
fi
# Anything not on the list: silently passes → fail-OPEN.
```

**Bad — hand-rolled use-position allowlist (Generation 3, over-admits):**

```bash
# Grep source text for call-sites matching the symbol name.
# String literals, type annotations, and commented-out calls all match → false negatives.
if ! grep -rn "\"$symbol\"\\|$symbol(" src/; then
  echo "DEAD: $symbol" && exit 1
fi
```

**Good — delegate to the authority: TypeScript compiler binding resolution (Generation 4, PR #415):**

```typescript
// Use tsc's type-checker binding graph. A symbol is WIRED iff the compiler
// resolves at least one reference at a value-position. No hand-rolled
// approximation; the type-checker is correct by construction.
const references = languageService.getReferencesAtPosition(file, symbolPos);
const valueRefs = references?.filter(r => !r.isDefinition && isValuePosition(r));
if (!valueRefs?.length) reportDead(symbol);
```

## Reference Implementation

- `hooks/push-to-main-guard.sh` — `SAFE_REFSPEC_RE` positive gate on the full refspec token; `is_push_everything_mode()` canonical-prefix regex for the `--all`/`--mirror` family; unknown-leading-word opaque passthrough with fail-closed scan-forward; getopt-cluster last-char flag matching (DESIGN-v2, PRs #376/#386/#402).
- `hooks/lib/canon-hook-lib.sh:canon_git_subcommand` — subcommand-level positive charset gate (pre-existing, never fail-opened).
- `hooks/dead-wire-gate.sh` (post-PR #415) — TypeScript compiler-API binding resolution: delegates to the type-checker as the reachability authority rather than any syntactic approximation.

## Exceptions

**Advisory-only hooks** (exit 0 always, carrying a `# DOCUMENTED FAIL-OPEN` comment) are not subject to this constraint — they make no block/allow decision. See `hooks-fail-closed` exception clause.

**Classifiers that are themselves tests** (e.g., `verify_dead_wire` unit-test scripts that exercise the gate logic) are exempt from the classifier-posture requirement for their internal test scaffolding, but the gate under test must still satisfy this convention.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "My recognized-wrapper list covers the wrappers that matter." | The list is always incomplete: `setsid`, `xargs`, `ionice`, `runuser`, `flock`, `taskset`, `caffeinate`, `watch` are all command-executing passthroughs. The next unlisted one is a bypass. | Treat unknown leading words as opaque passthrough → scan-forward → fail closed. |
| "Just add the missing wrapper/name/pattern to the list." | This is the Nth patch of the same enumeration-gap class. Each addition closes one form and opens the next. | Abandon enumeration for a fail-closed-on-unrecognized predicate (see `watch_UUUUUUUU2`). |
| "Exact-token matching of the flag is precise enough." | git's parse-options accepts unambiguous prefixes (`--al` for `--all`) and getopt clusters consume values (`-nu ci`). Exact-token matching misses both. | Use a positive canonical-prefix regex and model cluster last-char value consumption. |
| "I can grep source text to determine if a symbol is used." | String literals, type positions, and comments all match the grep. Re-exports and indirect calls do not. | Delegate to the compiler's binding graph — it is the authority on reachability. |
| "A static regex is fast enough for this check." | Speed is not the question. A static regex approximation of the type system will have both false positives and false negatives. | Invoke the authority (compiler, type-checker) rather than inferring from surface syntax. |

## Reviewer Check

When reviewing a classifier in `hooks/**` or `scripts/**` that emits a safety verdict, verify it does NOT:

1. Return ALLOW/PASS on an unrecognized form (fail-open on unknown).
2. Build its verdict by enumerating known-bad forms and permitting everything else (denylist posture).
3. Derive a verdict from syntactic approximation (regex, string matching) when a type-aware authority (compiler, type-checker) is available.

For shell-command parsers specifically, also verify it does NOT: (4) derive a substring from a pre-expansion token before applying a positive charset gate, or (5) rely on exact-literal flag matching where git accepts prefixes or getopt clusters.

Any of these is the denylist posture this convention forbids.

## Related

- [[hooks-fail-closed]] — the rule this convention sharpens: fail-closed behavior is required; this convention names the specific allowlist implementation that achieves it reliably.
- [[fail-closed-by-default]] — the general fail-closed principle; this convention is a domain-specific application of that posture to safety classifiers.
- [[hooks-observable-failures]] — sibling convention: when a hook swallows a failure silently, the failure must be made observable or justified.
- [[scanner-avoids-its-own-pattern]] — sibling convention: a scanner must not contain the literal pattern it detects (same `hooks/**` and `scripts/**` scope).
- [[probe-before-build-invoke-not-infer]] — when an authority exists (compiler, type-checker), invoke it rather than inferring from environment inspection; this is the design-phase analogue of the delegation principle above.

## Verification

- [ ] A classifier in `hooks/**` or `scripts/**` that emits a safety verdict defaults to SAFE/BLOCKED on any unrecognized form — it never returns ALLOW/PASS on first-unknown.
- [ ] No classifier builds its verdict by enumerating known-bad forms and permitting everything else.
- [ ] Where a type-aware authority (compiler, type-checker, declarative registry) exists for the classification, the classifier delegates to it rather than approximating syntactically.
- [ ] (Shell-command parsers) Each security-relevant token passes a strict positive charset gate BEFORE any substring derivation.
- [ ] (Shell-command parsers) Dangerous flags are matched by positive canonical-prefix regex (not exact-literal case arms) and getopt clusters are parsed by last-char value-consumption semantics.
