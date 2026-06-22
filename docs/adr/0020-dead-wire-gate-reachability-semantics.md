---
adr: "0020"
title: "Dead-wire gate reachability: same-file production use is wired; test-only reference is not"
status: accepted
date: "2026-06-22"
build: "make-the-dead-wire-gate-recognize-internal-same-file-use"
---

# ADR-0020: Dead-wire gate reachability — same-file production use is wired; test-only reference is not

## Context

`hooks/dead-wire-gate.sh` (the standing dead-wire reachability gate, ADR-0013) flags a
newly-exported symbol when it has no non-test reference outside its own defining file. Its
reachability filter computes `grep -rln "\bSYMBOL\b" mcp-server/src` then excludes (a) the
symbol's own definition file and (b) `*.test.ts` files; a non-empty remainder means "wired."

This mis-flags a real and recurring code shape: a symbol **used internally within its own
production file** and exported ONLY so its unit test can reach it. The same-file production use
is discarded by the `ref_file == local_file` exclusion, and the test reference is (correctly)
discarded too, leaving zero "wired" refs → false DEAD. Observed twice this session:
`isShipComplete` (janitor.ts — needed a `canon:allow-unwired` marker) and `extractLinks`
(markdown-corpus build, called by `buildCorpusLinkGraph` in its own file). The
`canon:allow-unwired` marker was being used as symptom treatment for live, internally-used code.

The gate is a deterministic safety control that runs in **every** autonomy tier. Loosening its
reachability definition is exactly the kind of change that can silently re-open the defect class
it exists to close (dead/unregistered exports). So the reachability semantics — *what counts as
"reachable"* — is a durable, cross-cutting, non-obvious decision worth recording.

## Options Considered

### Option A: Keep the marker as the mechanism (status quo)

**Pros:** No gate change; explicit human acknowledgement per case.

**Cons:** Treats live, internally-used code as if it were not-yet-wired. The marker's intent
(R4) is "genuinely not wired yet, intentionally" — using it for code that IS wired (just
internally) overloads the escape hatch and trains contributors to reach for it reflexively,
eroding its signal. Every internally-used test-exported symbol pays a marker tax forever.

### Option B: Count ANY reference, including from test files

**Pros:** Trivial one-line change (drop the `*.test.ts` exclusion).

**Cons:** **Breaks the gate's core job.** An exported symbol referenced *only* by its test
(`__tests__/x.test.ts`) with no production use is an unwired entry point — precisely the
dead-wire class. Counting the test reference would let it pass. Fails R3.

### Option C: Count a same-file PRODUCTION (non-test) reference as wired; never count a test reference

**Pros:** Recognizes that internal use is live code, while keeping the test-only entry point
flagged. Additive and fail-safe-toward-flagging — a `grep`/`sed` error returns "not used," so
the symbol stays a DEAD candidate (the gate never becomes more permissive on internal error).
Reuses the gate's existing identifier/whole-word grep idiom.

**Cons:** Same-file detection is textual (strip `//` comments, look for a whole-word occurrence
on a non-declaration line), so a same-file string-literal or comma-multi-declaration mention is
treated as use — narrow over-permissive edges. All such edges fail toward ALLOW and never turn a
wired symbol into a false DEAD, nor let a zero-ref (R2) or test-only (R3) export pass.

## Decision

Chosen: **Option C.** Reachability is redefined as:

> A new export is **wired** if it has a non-test reference **outside** its defining file
> (unchanged), OR a non-declaration reference **inside its own production source file**.
> A reference appearing **only** in a test file (`*.test.ts`, `*.spec.ts`, `**/__tests__/**`)
> does NOT make it wired.

Internal production use is the legitimizer; a test import is not. The detection is scoped to the
symbol's own production definition file (with a defensive early-out if that file is itself a test
file), so the test-only entry-point case (R3) keeps flagging. Reproduced and validated
empirically before freeze (PROBE-FINDINGS.md). The `canon:allow-unwired` marker remains the
escape hatch for genuinely-not-yet-wired exports (R4).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | New same-file check is additive; a grep/sed error returns "not used," keeping the symbol a DEAD candidate. Never more permissive on error. |
| deep-modules | honors | `is_internally_used` is a narrow predicate hiding the strip-comments/whole-word/non-declaration mechanics behind a yes/no interface. |
| consistent-abstraction-levels | honors | Stays a shell predicate inside the existing gate, alongside `check_suppression`. |

## Consequences

**Positive:**
- Internally-used, test-exported symbols (`isShipComplete`, `extractLinks`) pass marker-free.
- The `canon:allow-unwired` marker regains its precise meaning: genuinely-not-yet-wired only.
- R2 (zero-ref) and R3 (test-only entry point) remain flagged — the gate's core job intact.

**Negative / trade-offs:**
- Same-file detection is textual; a same-file string-literal/comment-free mention or a
  comma-multi-declaration second symbol can be treated as "used" (documented over-permissive
  edges). The marker and biome `noUnusedLocals` remain available for the rare real miss.

## Revisit-If

- A reliable, cheap AST/semantic reachability source becomes available in the verify pipeline
  (e.g. LSP call-hierarchy) — replace the textual same-file heuristic with a precise one.
- The over-permissive comma-multi-declaration edge causes a real missed dead wire in practice —
  tighten the declaration-line recognizer to handle comma-separated declarators.
