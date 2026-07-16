---
adr: "0057"
title: "The loop-runner guardrail surface gets its own deny-list category — and ADR-0045's sensitive-path claim was false"
status: accepted
date: "2026-07-15"
build: "adjudicate-the-adr-0002-baseline-blindness-consequence-a-to-matching"
corrects: "0045"
---

# ADR-0057: `loop-runner-guardrail` deny-list category

## Context

ADR-0045 (2026-07-10) recorded, in its Consequences:

> "`loop-schema.ts` is sensitive-path (mcp-tool-contract) → build is supervised + adversarially
> re-reviewed."

**This is false, and appears to have never been checked.** It was inherited verbatim by the
ADR-0056 design in this build, and caught only at the plan-approval gate when the orchestrator
invoked the real tool instead of reading the ADR.

Verified by invoking `compute_autonomy_tier` and by reading `SENSITIVE_PATH_DENY_LIST` in
`mcp-server/src/features/orchestration/services/confidence-scorer.ts` directly:

- The `mcp-tool-contract` category contains exactly two patterns:
  `mcp-server/src/app/register-*.ts` and `mcp-server/src/shared/lib/tool-result.ts`.
- **Zero patterns in the entire deny-list match "loop".**
- With the ADR-0056 file list, `compute_autonomy_tier` returns `tier: "supervised"`,
  `floor_engaged: false`, `require_security: false`, `require_adversarial: false`, `score: 37` —
  supervised **by score, not by floor**.

So for ~5 days the tracked record asserted a safety property that did not hold. Any reader of
ADR-0045 — human or agent — would conclude that changes to the loop guardrail are adversarially
reviewed. They are not.

Three further facts sharpen the gap:

1. **The claim conflated two different surfaces.** `mcp-server/src/app/register-loops.ts` **does**
   exist and **is** covered by `mcp-tool-contract`'s `register-*.ts` pattern. The loops *tool
   contract* is floored. What is unfloored is `loop-schema.ts` — the *guardrail*. ADR-0045 named
   the right category for the wrong file.

2. **Supervised-by-score is not a safety property.** Score 37 sits 3 points below the light-touch
   threshold (≥ 40). The tier is a function of recent build history — clean-review rate, violation
   counts. As build health improves, this exact file set drifts to `light-touch` and loses the
   checkpoint. Nothing about the *content* of the change holds it. A floor is precisely the
   mechanism for "this surface is dangerous regardless of how well the last ten builds went."

3. **What `loop-schema.ts` actually governs is a safety boundary.** It is the sole mechanical
   enforcement point of the dc-05 determinism guardrail and the dc-06 read-only-runner invariant:
   `mutates_build` enforcement, `BUILTIN_MUTATION_TOOLS`, `BUILTIN_FORBIDDEN_MCP`, and
   `READ_ONLY_SHELL_COMMANDS` + the `Bash` read-only carve-out. It is the thing that stops a loop
   definition from being handed `Bash` plus a mutating command. Its sibling
   `date-shell-guard.ts` is a fail-closed allowlist whose own header records that **"Two
   successive denylist patches each missed one shape (positional, then `-f`)"** — a guard against
   a read-only loop runner *setting the system clock*, already wrong twice.

## Options Considered

### Option A: Do nothing; correct ADR-0045's prose only

**Pros:** Zero code change. The false claim stops propagating. Cheapest.

**Cons:** Leaves the guardrail unfloored, which is what the false claim was wrong *about*. The
protection everyone believed existed still wouldn't. Correcting the record to say "and that's
fine" without arguing why it's fine is worse than the original error.

### Option B: Add `loop-schema.ts` to the existing `mcp-tool-contract` category

**Pros:** One-line change. Matches what ADR-0045 claimed, so the record becomes true retroactively.
No new category, no CLAUDE.md prose change, no parity-test change.

**Cons:** Adopts ADR-0045's category error rather than fixing it. `loop-schema.ts` is not a tool
contract — it is a guardrail; the actual loops tool contract (`register-loops.ts`) is already
covered. Filing a guardrail under "tool contract" makes the category mean two things and makes the
next reader's mental model wrong in the same way ADR-0045's was. It also leaves
`date-shell-guard.ts` — the twice-patched clock-setting guard — unfloored.

### Option C (chosen): A new `loop-runner-guardrail` category covering the guardrail pair

Two patterns: `mcp-server/src/features/loops/loop-schema.ts` and
`mcp-server/src/features/loops/date-shell-guard.ts`.

**Pros:**
- Names the real boundary: the mechanical enforcement point for dc-05/dc-06. That is a principled,
  bounded surface — not a slippery slope — because dc-05/dc-06 are explicit tracked constraints
  with exactly these two enforcement files.
- Covers `date-shell-guard.ts`, which no option premised on ADR-0045's claim would have caught.
- Keeps `mcp-tool-contract` meaning one thing.
- Structurally mirrors `autonomy-tier-control`: a small set of co-dependent files that a build
  could edit to silently weaken a safety invariant.

**Cons:**
- A new category costs two parity surfaces: root `CLAUDE.md`'s `Categories:` line and
  `deny-list-parity.test.ts`. Both are mechanical and already exist for this purpose.
- Two files is a small category. Accepted — `autonomy-tier-control` is three, and a category's
  value is its boundary, not its size.

### Option D: Glob the whole feature — `mcp-server/src/features/loops/**`

**Pros:** Catches anything added to the feature later, including new guards.

**Cons:** Over-floors. `list-loops.ts` filtering, `load-loops.ts` ENOENT handling, and every test
file are not safety boundaries; flooring them makes routine loop work supervised + security +
adversarial for no benefit. Deny-list dilution is a real cost — a floor everyone routes around is
a floor that stops being read.

## Decision

Chosen: **Option C.**

Add a `loop-runner-guardrail` category to `SENSITIVE_PATH_DENY_LIST` with two patterns:

```
{ category: "loop-runner-guardrail", pattern: "mcp-server/src/features/loops/loop-schema.ts" },
{ category: "loop-runner-guardrail", pattern: "mcp-server/src/features/loops/date-shell-guard.ts" },
```

Update root `CLAUDE.md`'s `Categories:` line (parity-enforced by `deny-list-parity.test.ts`) and
the `compute_autonomy_tier` table in `mcp-server/.claude/CLAUDE.md`.

Separately, **amend ADR-0045 in place** with a correction note recording that its sensitive-path
claim was false, and what is true instead. Its decision and its staleness ledger are unaffected —
only the false Consequences bullet is corrected.

### Recursion, noted deliberately

This build edits `confidence-scorer.ts`, which is itself on the deny-list under
`autonomy-tier-control` (the self-governance tripod). So the build that closes a deny-list gap is
floored by the tripod guarding the deny-list. Verified by invocation — with
`confidence-scorer.ts` in scope and `override_tier: "autonomous"` deliberately passed,
`compute_autonomy_tier` returns `floor_engaged: true`, `floor_category: "autonomy-tier-control"`,
`require_security: true`, `require_adversarial: true`, `score: 0`. The override lost to the floor.

**That is the tripod working exactly as designed** (ADR-0044): a build that could weaken the floor
is itself floored. Recorded here because it is the kind of thing that looks like a bug when
rediscovered later.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| probe-before-build-invoke-not-infer | honors | This ADR exists *because* a claim was inferred from prose instead of invoked. Every fact here was established by invoking `compute_autonomy_tier` and reading the deny-list source. |
| fail-safe-defaults | honors | Replaces a history-dependent score with a content-dependent floor on a surface whose danger does not vary with build history. |
| least-privilege | honors | Two exact file patterns, not a feature-wide glob. |
| simplicity-first | tensions, justified | A new category costs two parity surfaces. Justified: reusing `mcp-tool-contract` would encode a known-wrong mental model. |

## Consequences

**Positive:**
- Changes to the loop guardrail now get `canon:security` + a fresh adversarial re-review
  regardless of build history or `override_tier`.
- `date-shell-guard.ts` — wrong twice already — is floored for the first time.
- ADR-0056's `superRefine` (the barrier making one of ADR-0002's two named noise sub-classes
  inexpressible, plus the any-change and `from:`-contradiction shapes ADR-0002 never named as
  noise — see ADR-0056 § Consequences for the corrected statement) can no longer be weakened by
  an unfloored build.
- The tracked record stops asserting a false safety property.

**Negative / trade-offs:**
- Routine `loop-schema.ts` changes (e.g. adding an `ORCHESTRATOR_ACTIONS` member) now carry a
  security + adversarial tail. Accepted: the same file also holds the mutation denylist and the
  shell allowlist, and a floor that exempts "routine" edits is not a floor.
- The category has two members and may look arbitrary without this ADR. That is what this ADR is for.
- **The floor is inert until this merges, the plugin updates, and the daemon restarts** —
  `compute_autonomy_tier` resolves `SENSITIVE_PATH_DENY_LIST` from the daemon's installed
  source, not the working tree. Builds touching `loop-schema.ts` before that window is complete
  are scored, not floored. Caught by the contract-compatibility juror: this ADR's own
  Consequences originally stated the floor engages "regardless of build history or
  `override_tier`" with no mention of this window — the same shape of defect (a floor-coverage
  assertion that does not yet hold) this ADR exists to correct in ADR-0045, reproduced in
  miniature and time-bounded, in the very document whose thesis is that this shape is the
  defect. Documentation only; no code change.

**Discovered, not fixed here:**
- A tracked ADR carried a false safety claim for ~5 days and was inherited verbatim by a
  downstream design. The claim was cheap to check (one tool call) and nobody checked it — including
  this build's architect, until the plan-approval gate. There is no mechanical gate that verifies
  a prose claim about tier/floor behavior against the real tool. Recorded as a follow-up; see
  Revisit-If.

## Revisit-If

- **A third file becomes a loop-guardrail enforcement point** — add it to this category rather than
  inventing a fourth pattern elsewhere.
- **A mechanical parity check for tier/floor prose claims becomes feasible** — a gate that greps
  tracked docs for sensitive-path assertions and validates them against `SENSITIVE_PATH_DENY_LIST`
  would have caught ADR-0045 line 100 at write time, and would have caught this build's design
  before the gate did. This is the general form of the defect and is worth its own build.
- **Deny-list dilution becomes a real problem** (categories proliferate, builds route around the
  floor) — revisit whether guardrail surfaces should collapse into one `canon-safety-boundary`
  category rather than one category per subsystem.
