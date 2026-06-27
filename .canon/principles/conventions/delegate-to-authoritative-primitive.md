---
id: delegate-to-authoritative-primitive
title: Delegate Classification to the Authoritative Primitive; Don't Enumerate the Surface
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "hooks/**"
    - "**/hooks/**"
    - "**/*.ts"
  tags:
    - security
    - hooks
    - safety
    - classification
    - posture
---

When a safety classifier, gate, or guard must reconstruct semantics that an authoritative tool already computes, do NOT re-derive them by enumeration. Either (a) **call the authoritative primitive inline** at the existing layer, or (b) **relocate the gate to the layer where the authority has already resolved the answer**. Enumerating the surface always leaves the next unlisted form open.

## The Rule

1. **Identify the authoritative primitive first.** Before writing any classifier, ask: "Which platform tool (git, TypeScript compiler, shell grammar, canonical parser) already answers the underlying question?" That tool is the authority.
2. **Mechanism A — call authority inline.** When the authority is callable at the current gate layer, invoke it directly:
   - "Does this diff touch a new ADR file on HEAD vs origin/main?" → `git diff origin/main..HEAD` (two-dot, tree-vs-tree). NOT three-dot (merge-base pivot misses ancestry-independent collisions).
   - "Does this identifier reference this declared symbol?" → TypeScript compiler `getSymbolAtLocation`. NOT a syntactic-position enumeration.
   - "Is this token a git subcommand?" → `canon_git_subcommand` positive-charset gate in `hooks/lib/canon-hook-lib.sh`. NOT a case-arm list.
3. **Mechanism B — relocate to the authority's layer.** When the authority's resolution is inherently layer-bound (it cannot be queried from outside its own execution context), move the gate to that layer:
   - "What repo is being pushed?" → git `pre-push` hook. Git resolves the repo before running the hook, regardless of how push was invoked (`-C`, `cd &&`, `--git-dir`, `GIT_DIR=`, multi-segment chains). The command-parsing machinery is deleted, not extended.
4. **Stop extending an enumeration that doesn't converge.** The diagnostic signal (see below) identifies when you have crossed from "incomplete fix" to "wrong approach."

## Diagnostic Signal

**Repeated fail-OPENs of DIFFERENT shapes on the same classifier is the rethink trigger.**

- **Same-shape fail-OPENs** (the same form re-introduced, the fix was incomplete): extend the fix.
- **Different-shape fail-OPENs** (each round surfaces a distinct new bypass form): the underlying question cannot be answered by static enumeration at this layer. Stop patching; identify and delegate to the authority.

The signal threshold is 3+ rounds of different-shape fail-OPENs with all reviewer findings confirmed as true positives. At that point the correct action is to surface a "design change needed" signal before spawning another patch engineer (see CLAUDE.md → Auto-Escalation Protocol → Adversarial-surface iteration signal).

Three instances established this threshold:

| Instance | Enumeration that failed | Authority that converged it | Mechanism |
|----------|------------------------|-----------------------------|-----------|
| PR #419, ADR gate three-dot diff | Three-dot diff pivot, ancestry-dependent | `git diff origin/main..HEAD` (two-dot, tree-vs-tree) | Call authority inline |
| PR #415, dead-wire use-position detector | ~330-line syntactic-position allowlist (6+ leak classes) | TypeScript compiler `getSymbolAtLocation` (~40 lines) | Call authority inline |
| PR #419, adr-number-check.sh cwd-scoping | Static bash cwd-parser (5 distinct shapes across 4 rounds) | git `pre-push` hook (git resolves repo before hook runs) | Relocate to authority's layer |

## Relationship to `[[security-hook-parser-allowlist-posture]]`

These two conventions address different levels of the same problem:

- **`[[security-hook-parser-allowlist-posture]]`** governs **parser DESIGN**: when you must parse a command string, enumerate the provably-safe forms and fail closed on anything outside that set.
- **This convention** governs **question DESIGN**: before building any classifier, ask whether static enumeration can close the answer space at all.

Use allowlist posture when enumeration CAN close the space (finite, statically-knowable safe charset). Delegate to or relocate to the authority when enumeration CANNOT close the space (unbounded, platform-semantics-dependent, or adversarially open-ended).

The two apply in sequence: first ask "can this question be closed by static enumeration?" If yes, use allowlist posture. If no, identify the authoritative primitive.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I just need to add one more case to the list." | Each addition closes one form and leaves the next unlisted form open. Enumeration converges asymptotically, not to zero. | Check whether the fail-OPENs are same-shape or different-shape. Different-shape → rethink. |
| "The authoritative primitive has overhead / requires a subprocess." | One subprocess call beats an infinite patch series. The dead-wire fix collapsed ~330 lines to ~40; the pre-push relocation eliminated the entire parser. | Call the authority. Performance is recoverable; an open-ended bypass surface is not. |
| "The gate is at the wrong layer to call the authority." | That is precisely the signal to RELOCATE the gate. | Move the gate to where the authority already has the answer. |
| "The fail-OPENs are different shapes but I can enumerate them this time." | You are re-stating the assumption that produced the prior 3+ rounds. | Apply the diagnostic signal: different shapes = rethink trigger. |

## Verification

- [ ] The classifier identifies an authoritative platform primitive (git, TypeScript compiler, canonical parser) that answers the underlying question directly.
- [ ] Either the primitive is called inline, OR the gate has been relocated to the layer where the authority's resolution is already available.
- [ ] No enumeration of fail-open forms is present in the security-critical path.
- [ ] If 3+ distinct fail-open shapes appeared across prior rounds, the diagnostic signal was surfaced before another patch iteration was started.

## Related

- `[[security-hook-parser-allowlist-posture]]` — sibling convention governing parser DESIGN (allowlist over pre-expansion tokens); complements this convention's question-DESIGN scope.
- `[[hooks-fail-closed]]` — rule requiring all non-advisory hooks to fail closed; this convention names the structural approach that achieves reliable closure when enumeration cannot converge.
- `[[probe-before-build-invoke-not-infer]]` — sibling convention requiring empirical probes over environment-inspection inferences; shares the "invoke the capability, don't reason about it from the outside" posture.
