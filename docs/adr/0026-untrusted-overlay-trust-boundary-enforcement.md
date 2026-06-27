---
adr: "0026"
title: "Untrusted overlay trust boundary is compiler-and-test enforced, not per-sink fenced"
status: accepted
date: "2026-06-27"
build: "overlay-inert-data-hardening-4-redesign-replace-the-falsified-scanner"
supersedes: ~
extends: "0025"
---

# ADR-0026: Untrusted overlay trust boundary is compiler-and-test enforced, not per-sink fenced

## Context

ADR-0025 made overlay content structurally inert (neutralize + fence + tier) and is sound. But the
*application* of the fence was per-sink: each MCP tool that serves a project-local principle/routine
field to the model had to remember to call `fenceUntrustedOverlay`. Three consecutive adversarial
passes each re-found the SAME class at a DIFFERENT sink:

1. Review — routine `name` unfenced.
2. Security pass 1 — principle `title`/`id`/`severity` + routine `cron`/`event`/`repos` unfenced.
3. Security pass 2 (post-fix) — `review_code` returns project principle `title`+`body` raw;
   `list_principles` forwards `tags[]`/`scope.layers[]`/`scope.file_patterns[]` raw.

Per-sink patching is a treadmill: the fix and the bug share the author's "my listed sinks are
covered" frame, which structurally cannot hold the adversary's "every field of the record, through
every sink, is a leak until an invoked proof shows it fenced" frame (watch_CCCCCCCCCCCC1). The
boundary needed to stop depending on reviewer/author vigilance.

## Options Considered

### Option A: Keep per-sink fencing, add more tests
**Pros:** smallest diff. **Cons:** the treadmill itself — already failed 3×; unbounded.
**Alignment:** violates the spirit of `security-hook-parser-allowlist-posture` (enumerate-the-known).

### Option B: Intersection brand `type UntrustedText = string & { __brand }`
**Pros:** intuitive "branded string"; tiny ripple (no object box). **Cons:** **FALSIFIED by probe** —
a `string & {...}` value is a *subtype* of `string`, so `const x: string = branded` compiles with
ZERO diagnostics. It enforces nothing at a model-facing sink (it only blocks the reverse direction).
Shipping it would have re-created the PR #420 "looks-like-a-guard, enforces-nothing" failure at the
type level. **Alignment:** none — it is the type-level cousin of the falsified scanner.

### Option C: Opaque-box type + load-boundary closed-domain validation + sink-coverage test (chosen)
A two-class field model with three composed enforcement layers. **Pros:** the next drifting sink is a
`tsc` error (free-text) or impossible (closed-domain already-safe value) or a CI failure
(brand-bypassing concat). **Cons:** bounded one-time ripple (~15 source + ~36 test files); the
free-text fields become objects, forcing brand-preserving signatures on the structural transforms.
**Alignment:** honors `validate-at-trust-boundaries`, `fail-closed-by-default`, `deep-modules`,
`security-hook-parser-allowlist-posture`.

## Decision

Chosen: **Option C.** Every model-facing field of `Principle`/`Routine` is exactly one of two
classes, and the class — not a per-sink reviewer decision — determines safety:

- **Closed-domain fields** (`id`, `severity`, `tags`, `scope.layers`, `scope.file_patterns`,
  `scope.tags`, routine `name`/`cron`/`event`/`repos`/enums): **charset/enum-validated at the single
  load boundary** (`parser.ts`/`routine.ts`), dropping non-matching entries fail-closed. An unsafe
  value cannot exist in the loaded object, so no current or future sink can emit one. Zero per-sink
  work.
- **Genuinely-free-text fields** (`title`, `body`, `anti_rationalization`, `verification`): carry an
  **opaque object type `UntrustedText = { readonly [tag]: "UntrustedText"; readonly _v: string }`**
  (NOT a `string` subtype) defined in `shared/lib/overlay-untrusted-text.ts`. The ONLY way to turn it
  into a model-emittable `string` is `renderUntrusted(v, { source })` /
  `renderUntrustedProjection(...)`, which fence for `source==="project"` and pass through for
  `plugin`/`undefined`. A sink that assigns a free-text field into a `string` output is a TS2322
  error. Non-model-facing structural consumers use brand-preserving transforms or the single audited,
  greppable `rawUntrustedForStructuralUse(v)` accessor.
- A **sink-coverage test** (`overlay-sink-coverage.test.ts`) backstops both at CI: it invokes every
  principle/routine sink against an all-fields-injected `source:"project"` fixture and asserts no
  token reaches an unfenced position, plus a `source:"plugin"` fixture asserting NO fencing. It
  catches what types cannot — a new unbranded field, an unwrap-then-concat, or a raw-accessor misuse.

The opaque **box** (not an intersection brand) is load-bearing and non-negotiable — see the probe.

## Negative control (verified)

Adding `const x: string = somePrinciple.title;` to any sink produces:
```
error TS2322: Type 'UntrustedText' is not assignable to type 'string'.
```
The intersection-brand equivalent produces NO error — which is exactly why it was rejected.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| validate-at-trust-boundaries | honors | closed-domain validation at the single load point; free-text fenced at the model-facing sink |
| fail-closed-by-default | honors | invalid closed-domain entries dropped; the box has no implicit string coercion |
| deep-modules | honors | `overlay-untrusted-text.ts` hides box + fence composition; `_v` never escapes it |
| security-hook-parser-allowlist-posture | honors | closed-domain is allowlist/charset fail-closed; enforcement is a posture rethink, not another enumeration |
| simplicity-first | tension (justified) | one-time bounded ripple vs an unbounded per-sink treadmill that failed 3× |

## Consequences

**Positive:**
- The Finding-1 (review_code) and Finding-2 (list_principles) classes close, and the *next* sink
  fails closed at build (free-text) or CI (coverage test) without any reviewer vigilance.
- All sinks unify on `renderUntrusted*`; manual `source==="project" ? fence : raw` ternaries are
  deleted (net simplification at the call sites).

**Negative / trade-offs:**
- `Principle.title/body` and `Routine.title/body` are objects, not strings — structural transforms
  (`extractSummary`, `filterBodyBySections`, `normalizeTitle`, disk-recipe rendering) require
  brand-preserving signatures or the audited raw accessor; ~36 test fixtures wrap literals in a brand.
- `rawUntrustedForStructuralUse` is an escape hatch; its safety is a CI-test invariant
  (non-model-facing only), not a type guarantee.

## Revisit-If

- A future contributor proposes collapsing the opaque box into an intersection brand "for
  simplicity" → reject; re-read the probe (the brand enforces nothing).
- A new untrusted overlay record type is added → give its free-text fields `UntrustedText` and add it
  to the sink-coverage test; closed-domain fields get a load-boundary charset.
- The model is shown to act on fenced data despite ADR-0025's policy → strengthen framing per
  ADR-0025 Revisit-If; not this ADR's concern.
