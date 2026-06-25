---
adr: "0022"
title: "Same-file dead-wire internal-use detection uses TypeScript compiler-API binding resolution, not regex or syntactic allowlists"
status: accepted
date: "2026-06-24"
build: "rethink-the-dead-wire-gates-same-file-internal-use-detector-replace-the"
---

# ADR-0022: Same-file dead-wire internal-use detection uses TypeScript compiler-API binding resolution, not regex or syntactic allowlists

## Context

The dead-wire gate (`hooks/dead-wire-gate.sh`) is a deterministic safety gate in the verify
chain. To decide whether a newly-exported symbol has any same-file internal use, it must
answer: *is this symbol referenced by real same-file code (not a comment, not a string, not a
member-property name on an unrelated object, not a shadowing local)?*

Two prior approaches failed, each producing a fresh bypass class discovered by adversarial
review:

**Phase 1 — regex comment-stripping.** TypeScript's comment/string/regex grammar is not
regular. The regex pipeline was patched three times (sed → 2-pass perl → 3-pass perl); each
patch closed one known form and opened the next (block-comment-only, unterminated `/*`,
comment-inside-string, comment-inside-regex, bare-token-after-comment, nested `/* /* */`).
`principles/conventions/security-hook-parser-allowlist-posture.md` requires that at the Nth
patch of a bypass class we rethink the posture rather than enumerate the next form.

**Phase 2 — tree-sitter parse-aware occurrence counting with `isUsePosition` allowlist.** A
tree-sitter `isUsePosition` allowlist classified each identifier occurrence by AST role and
counted only occurrences in use positions. Two residual fail-OPEN false-WIRE holes were found
that the allowlist structurally cannot close:

1. **Member-property over-admission** — the `member_expression` branch counted BOTH the
   `object:` and `property:` positions, so `res.deadFn` (a property name on an unrelated
   object) counted as a use of a top-level export `deadFn`. Extremely common for short names
   (`status`, `kind`, `type`, `id`, `name`, `data`).
2. **Scope-shadowing** — the counter was scope-unaware. A dead export shadowed by a used local
   of the same name (`const deadFn = 2; return deadFn`) or a parameter counted the local's
   use toward the export.

Both defects are fail-OPEN (false-WIRE). The root cause is that occurrence-counting over
syntax cannot distinguish a member-property name from an identifier that RESOLVES to the
top-level export vs a shadowing local. This requires name-binding / scope resolution, not more
syntactic rules. The governing principle says: at the Nth patch of a bypass class, rethink the
posture.

The gate is deterministic, runs in every autonomy tier in the verify chain, and is
load-bearing fail-closed: any error must flag DEAD, never WIRED.

## Options Considered

### Option A: TypeScript compiler-API binding resolver (single-file in-memory Program)

Build a single in-memory `ts.Program` from the one file (`noResolve/noLib/types:[]`, minimal
`CompilerHost`, no tsconfig); use the type-checker to resolve each occurrence to its binding;
count an occurrence ONLY when it resolves to the top-level exported symbol. Bail fail-closed on
non-empty `sourceFile.parseDiagnostics` (syntactic parse errors) before building the Program.

**Pros:**
- Correct **by construction** — the checker does real binding resolution, distinguishing
  member-property, shadowing locals/params, type-vs-value namespaces, and aliases.
- SUBSUMES and REPLACES the `isUsePosition` allowlist (~330 lines) with a ~40-line resolver.
- Reuses the already-present `typescript` dependency — no new runtime dependency.
- Empirically passes all 10+ discriminating fixtures including both BLOCKING defects
  (`PROBE-SCOPE.md`).
- Fail-closed on every error path: compiler throw, missing `typescript`, node absent,
  bad args, missing file, parse errors, timeout.

**Cons:**
- Cold one-shot ~0.24s (node boot + load `typescript.js`) vs tree-sitter ~80ms boot —
  fires only for candidate-dead exports (rare), within the existing `timeout 20`.
- One non-obvious detail: shorthand-property identifiers need
  `getShorthandAssignmentValueSymbol` (surfaced by the probe).

**Canon-principle alignment:** honors `security-hook-parser-allowlist-posture` (posture
completion — delegate to an authoritative resolver), `hooks-fail-closed`, `deep-modules`,
`no-new-dependency`, `correctness-scan`.

### Option B: tree-sitter `locals.scm` scope query

Run an approximate `locals.scm` scope/definition/reference query against the committed grammar
and resolve shadowing/member-property from the captures.

**Pros:**
- Lighter runtime than building a TS Program; reuses web-tree-sitter.

**Cons:**
- No `locals.scm` ships with the bare committed `.wasm` grammars — requires vendoring a
  grammar query (new surface).
- tree-sitter locals queries are a documented heuristic scope approximation, not a real
  binding resolver — weakest exactly on the shadowing case this build must close.
- Trusting an approximation in a fail-closed safety gate re-opens the "missed a form" defect
  class.

**Canon-principle alignment:** tensions `security-hook-parser-allowlist-posture` (approximate
resolution is still partial enumeration); weaker `deep-modules` (vendored query + interpretation
logic).

### Option C: hand-rolled scope walk on the existing CST (augment the allowlist)

Keep `isUsePosition`; add a hand-rolled binding-scope tracker to resolve occurrences to the
nearest binding and exclude the member-property field.

**Pros:**
- No additional node-boot cost beyond the tree-sitter phase.

**Cons:**
- A partial hand-rolled scope resolver is the treadmill the governing principle says to stop
  (closures, hoisting, block-vs-function scope, type/value namespaces, `this`-params,
  ambient declarations — each missed form is the next false-WIRE).
- Grows the already-large surface; more code, weaker guarantee.

**Canon-principle alignment:** directly tensions `security-hook-parser-allowlist-posture`;
tensions `deep-modules`.

## Decision

Chosen: **Option A — TypeScript compiler-API binding resolver.**

A single in-memory TS Program resolves all discriminating fixtures by construction —
including both open BLOCKING defects (member-property false-WIRE, scope-shadowing false-WIRE)
— needs no tsconfig, reuses the already-present `typescript` dependency, is fail-closed on
every error path (including syntactic parse errors via `sourceFile.parseDiagnostics`), and
costs ~0.24s cold per candidate-dead symbol (sub-ms analysis). It subsumes and replaces the
`isUsePosition` allowlist. Options B and C were rejected: B is heuristic and requires vendoring
a grammar query; C is the enumeration treadmill this build exists to retire. Decisive evidence:
`PROBE-SCOPE.md` (invoke-not-infer).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| security-hook-parser-allowlist-posture | honors | Completes the posture: delegate binding resolution to the authoritative TS type-checker instead of enumerating use positions or hand-rolling scope. |
| hooks-fail-closed | honors | Every error path (compiler throw, missing `typescript`, node absent, bad args, missing file, parse errors, timeout) ⇒ non-zero exit ⇒ DEAD. WIRED structurally requires a successful run with count ≥ 1. |
| deep-modules | honors | Same 2-arg CLI interface (`node dead-wire-internal-use.mjs <file> <symbol>` → integer stdout); ~330-line allowlist body replaced by a ~40-line resolver. |
| no-new-dependency | honors | `typescript` (6.0.3) is already an mcp-server dependency (server runs on tsx → typescript). |
| correctness-scan | honors | Closes both BLOCKING findings by construction. Member-property and shadowing defect classes are closed structurally, not enumerated. |

## Consequences

**Positive:**
- Zero false-WIRE by construction for member-property and shadowing — the two open defect
  classes are closed structurally, not enumerated.
- The detector is smaller and simpler (resolver replaces allowlist).
- Future TS syntax forms (new positions, namespaces, aliases) are handled by the checker
  automatically, not by adding allowlist branches.
- Syntactic parse errors bail fail-closed before any binding resolution, preventing partial-AST
  mis-binding.

**Negative / trade-offs:**
- Per-candidate cold cost rises from ~80ms (tree-sitter) to ~0.24s (TS compiler boot). Bounded
  by (# candidate-dead exports) × ~0.24s within the existing `timeout 20`; candidate deads are
  rare.
- The gate now depends on `typescript` resolving from `mcp-server/node_modules` in the helper's
  context. If `typescript` is ever absent, the helper fails closed (DEAD), which is safe but
  could over-flag — the same availability posture as the prior web-tree-sitter dependency.
- `sourceFile.parseDiagnostics` is a non-enumerable internal property of TS SourceFile.
  Directly accessible in TS 6.0.3 (verified by probe); if a future TS version removes it,
  the guard silently becomes a no-op on that path. Supported alternative: `ts.createProgram
  (...).getSyntacticDiagnostics(sourceFile)` — but requires building the Program first.

## Revisit-If

- The cold ~0.24s per-candidate cost becomes material because a build introduces many
  candidate-dead exports at once (e.g. a large scaffolding PR) — then batch the helper into a
  single long-lived process invocation instead of one process per symbol.
- TypeScript is removed as an mcp-server dependency, or the server stops running on tsx —
  then re-evaluate the availability/fail-closed posture.
- `sourceFile.parseDiagnostics` is removed in a future TS version — migrate to
  `getSyntacticDiagnostics(sourceFile)` and accept the cost of building the Program before
  the guard.
- The gate is generalized to run as a portable hook on arbitrary consumer installs (the
  node/typescript availability assumption would no longer hold).
