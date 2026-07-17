---
adr: "0056"
title: "TypeScript 7 migration: split the compiler (typechecking) from the tooling parser (AST lint tools)"
status: accepted
date: "2026-07-15"
build: "migrate-mcp-server-to-typescript-702-tsconfig-baseurl-removal-relative"
---

# ADR-0056: TypeScript 7 migration — split the compiler from the tooling parser

## Context

Dependabot PR #501 proposed bumping `typescript` 6.0.3 → 7.0.2 in `mcp-server`. TypeScript 7 is
the native Go port of the compiler, and it changes the shape of the npm package in a way release
notes alone did not make obvious: `import "typescript"` now yields only `{ version,
versionMajorMinor }` — the entire JavaScript compiler API (`createSourceFile`, `forEachChild`,
`SyntaxKind`, `ScriptTarget`, etc.) is gone from the package's main entry point. This was verified
by invoking TS 7.0.2 directly (see `PROBE-FINDINGS.md`, this build's throwaway probe worktree),
not inferred from release notes, per `probe-before-build-invoke-not-infer`.

The repo used one `typescript` dependency for two unrelated jobs:

| Job | What it needs | Consumer |
|---|---|---|
| Typecheck `src/` | a **compiler** (`tsc` binary) | `npm run build`, CI |
| Parse JS for lint tooling | a **JS parser + AST API** | 3 scripts behind 3 fail-closed gates |

That coupling was incidental, and TS 7 severs it: it ships a superb compiler and simultaneously
deletes the JS parser API from the surface those three scripts depended on:

- `mcp-server/scripts/workflows-lint.mjs` (backs `hooks/workflows-lint.sh`)
- `mcp-server/scripts/dead-wire-internal-use.mjs` (backs `hooks/dead-wire-gate.sh`)
- `mcp-server/scripts/tool-surfacing-extract.mjs` (backs `hooks/tool-surfacing-check.sh`, ADR-0048)

All three are fail-closed safety gates. The probe additionally found: `mcp-server/tsconfig.json`'s
`baseUrl` + non-relative `paths` aliases are rejected outright by TS 7 (`TS5102`/`TS5090`); the
breakage tail was NOT bounded to the two symptoms the PRD started from (two more broken scripts,
49 downstream test failures, masked by CI's `lint` job failing first and short-circuiting
`build`/`test`); and TS 7's surviving `unstable/*` API is an IPC client to a Go server process,
`Project`/`Program` oriented, with **no string→AST parse entry point at all** — there is no way to
migrate the three scripts onto TS 7's own API without spawning a Go server per lint invocation
against an explicitly-unstable interface.

**A third config, missed on the first pass:** the repo has THREE `tsconfig.json` files —
`mcp-server/tsconfig.json` (migrated above), `mcp-server/tsconfig.lint.json` (`extends` the first,
inherits the fix for free), and the **repo-root** `tsconfig.json`, which `extends` `mcp-server/tsconfig.json`
but re-declares its own `baseUrl`/`paths` (TypeScript does not merge `paths` across `extends` —
the child's own `paths` fully replaces the parent's). Neither CI (which only ever resolves
`mcp-server/tsconfig.json`) nor the original probe (run from inside `mcp-server/`) could see this
config; a review caught it. See Negative/trade-offs below for the fix and the one deliberate,
behavior-preserving deviation it required.

## Options Considered

### Option A: Stay on TypeScript 6, ignore the major bump

**Pros:**
- Zero migration risk; no new dependency, no frozen parser.
- TS 7's benefit here is primarily compile speed — `npm run build` only emits `.d.ts` via
  `emitDeclarationOnly`, so the speed win is modest for this repo's build step.
- TS 7's JS API is self-labelled `unstable/`, so the ecosystem has not settled around it yet.

**Cons:**
- Defers rather than resolves — Dependabot will re-propose the bump indefinitely.
- The migration is already proven to work (this build); ignoring it forgoes evidence already in
  hand and re-incurs the investigation cost on every future re-proposal.

**Canon-principle alignment:** `simplicity-first` favors this narrowly (nothing to build), but
`scope-discipline`'s spirit (resolve rather than defer a well-understood, bounded cost) favors
Option B once the true cost is measured rather than assumed.

### Option B: Adopt TS 7 for typechecking; pin TS 6 as a dedicated tooling parser

Add `typescript-parser: npm:typescript@6.0.3` as a second devDependency (an npm alias — the same
package under a different import specifier), used exclusively by the three AST-consuming scripts
via one shared seam (`scripts/lib/ts-compiler.mjs`), while `typescript` itself moves to `7.0.2` and
serves `tsc`/typechecking.

**Pros:**
- Proven end-to-end, including adversarially: `tsc --noEmit` exits 0 under TS 7 (zero
  `TS5102`/`TS5090`), all three scripts run clean, the full gate set is green, and the linter still
  fails closed on bad input (`Date.now()`, malformed JS, missing `meta`, and the new
  **missing-parser** case this migration introduces).
- Module resolution is provably unchanged, not just "the suite is green" — 1284/1284 alias
  resolutions are byte-identical between the old (`baseUrl`) and new (relative `paths`) tsconfig
  with the compiler held constant.
- The cost is small and one-time: a tsconfig edit, one dependency line, one import line per script.
- Localizes the substrate choice to one seam (`ts-compiler.mjs`), so any future swap (see
  Consequences) changes one file, not three.

**Cons:**
- We now depend on TypeScript twice in one `package.json`, one of them under a deliberately
  frozen major version — a genuinely surprising fact to a future contributor without this record.
- Freezes the AST-tooling parser on TS 6 indefinitely (see Revisit-If).
- Adds a second ~30MB dev-only copy of TypeScript to `node_modules`.

**Canon-principle alignment:** `fail-closed-by-default` — the seam is a positive-assertion,
exit-on-failure module with no optional chaining, no `??` fallback, and no swallowing catch; a
linter that cannot resolve its parser exits non-zero, it never silently passes.
`probe-before-build-invoke-not-infer` — every claim above was produced by invoking TS 7.0.2, not
by reading its release notes.

## Decision

Chosen: **Option B — adopt TypeScript 7 for typechecking, pin TypeScript 6 as a dedicated tooling
parser under the `typescript-parser` alias.**

The work is proven and green, `#501` unblocks with no hand-edits to the Dependabot branch, and
ignoring the bump only defers a cost that has now already been paid and measured. The honest
trade-off — freezing the AST-tooling parser on TS 6 — is real and is why this decision earns a
durable ADR rather than living only in a build's PROBE-FINDINGS: it becomes load-bearing for three
safety gates, it is exactly the question a future contributor will ask ("why does this repo depend
on TypeScript twice?"), and staying on TS 6 entirely was a real, PRD-blessed alternative with real
costs of its own.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `fail-closed-by-default` | honors | `scripts/lib/ts-compiler.mjs` positively asserts the required API surface and `process.exit(1)`s on any gap — no optional chain, no `??` fallback, no swallowing catch, no degraded return. Verified adversarially: missing-module and missing-API-key cases both exit non-zero naming the gap; `hooks/workflows-lint.test.sh` covers a missing-parser fixture end-to-end via perturb/observe/revert on the real installed dependency. |
| `probe-before-build-invoke-not-infer` | honors | Every TS 7 behavior claim in this ADR and the build's design was produced by invoking TS 7.0.2 in a throwaway probe worktree (`PROBE-FINDINGS.md`), not inferred from release notes or prior TS-version behavior. |
| `simplicity-first` | honors, with a stated tension | The chosen fix is the smallest proven change (tsconfig edit, one dependency line, one import per script) — a rewrite onto TS 7's own AST API was evaluated and rejected as substantially larger and riskier (no string→AST entry point exists). The tension: two TypeScript dependencies in one project is not "simple" on its face; it is accepted because the alternative (a parser rewrite, or hand-rolling dead-wire's binding resolution) was evaluated and found strictly worse on measured evidence, not assumed worse. |
| `scope-discipline` | honors | Zero behavior change to shipped runtime code — `git diff` touches only `tsconfig.json`, `package.json`/`package-lock.json`, `scripts/**`, new tests, and this ADR. No `src/**` runtime file changed. |

## Consequences

**Positive:**
- `mcp-server` typechecks under TypeScript 7.0.2; `npm run build` and CI's `build` job benefit from
  the native Go compiler.
- All three fail-closed safety gates (`workflows-lint`, `dead-wire-gate`, `tool-surfacing-check`)
  continue to work, and continue to fail closed — including on two new failure modes this
  migration itself introduces (parser unresolvable; parser surface-complete but
  behaviorally degraded on `parseDiagnostics` — see Negative/trade-offs), both test-covered.
- The substrate choice is localized to one seam module. A future parser swap (see below) is a
  one-file change, not a three-script rewrite.

**Negative / trade-offs:**
- The AST-tooling parser is frozen on TypeScript 6.0.3 indefinitely, tracked via the
  `typescript-parser` alias rather than a normal semver range on `typescript`.
- **`parseDiagnostics` is an internal, undocumented API the seam cannot assert structurally —
  bumping `typescript-parser` requires re-verifying it manually or via the probe.** The seam's
  surface assertion (`scripts/lib/ts-compiler.mjs`) only checks top-level `ts.*` members; all three
  fail-closed gates depend on `sourceFile.parseDiagnostics`, a property of the object
  `createSourceFile` *returns* — structurally outside what a top-level assertion can see, and
  absent from `typescript-parser`'s public `.d.ts`. A security review demonstrated this
  concretely: a parser stub exporting every declared top-level member (passing the surface
  assertion cleanly) but whose `createSourceFile` never populated `parseDiagnostics` made
  `workflows-lint.mjs`'s original `sf.parseDiagnostics ?? []` fallback silently treat every
  malformed input as clean (exit 0, no output) — the exact silent-pass failure mode this whole
  migration exists to prevent. Fixed by adding a BEHAVIORAL probe to the seam: after the surface
  assertion passes, for any caller that declared `createSourceFile`, the seam itself parses a
  known-malformed source and requires a populated `parseDiagnostics` array, `fail()`-ing
  otherwise. **The probe's guarantee is conditional on what the caller declares, not
  unconditional or structural** — a first version of this fix (gating on
  `createSourceFile`/`ScriptTarget`/`ScriptKind` together) was itself found to be **stricter than
  the actual condition** ("does this caller parse?"): `ScriptKind` is an OPTIONAL parameter of
  `createSourceFile`, so a caller can legitimately parse without ever declaring it, and the
  narrower gate left exactly that shape unprobed — a smaller instance of the same silent-pass
  hole. Corrected to gate on `createSourceFile` alone (the one member whose *return value* the
  probe actually inspects), with an explicit positive assertion that `ts.ScriptTarget.Latest` is
  present before using it to construct the probe's own call (failing loudly if a caller parses
  without ever declaring `ScriptTarget`, rather than silently working around it). The three
  callers' own `parseDiagnostics` derefs were also hardened from short-circuiting (`?? []`,
  `if (parseDiags && ...)`) to positive assert-and-fail, so a contract violation past the probe is
  still loud, not silently skipped.

  **A fresh adversarial review (post-gate-fix) found the probe still checked only ONE fixture.**
  A stub could special-case the exact string `"const x = ;"` — reporting real diagnostics only
  for that literal input and empty diagnostics for everything else — and pass cleanly (executed,
  confirmed exit 0). This is outside the version-drift threat model the probe defends against
  (defeating one memorized fixture is deliberate sabotage, not the incidental degradation an alias
  bump would cause), so it was a WARNING, not a BLOCKING finding — closed anyway before ship. The
  same review separately noted the probe never checked that a *valid* parse returns a real,
  walkable tree — a parser could report `parseDiagnostics` correctly (passing every probe above)
  and still return a structurally wrong or empty AST, silently breaking the ban-walk and
  binding-count logic in all three scripts even while "looking" healthy.

  **A second adversarial review (ATTACK 4) found the AST-shape side was still JS-only.** The
  caller audit is why that mattered: `workflows-lint.mjs` parses JS, but
  `dead-wire-internal-use.mjs` and `tool-surfacing-extract.mjs` — both fail-closed safety hooks —
  parse exclusively in TS/TSX mode. Probe C (below) guarded the mode 1 of the 3 callers uses; the
  two safety-hook extractors' valid-tree integrity was unprobed. Executed: a stub correct on
  diagnostics in both modes and correct-tree for valid JS, but returning a degenerate empty tree
  for valid TS specifically, passed the seam cleanly (exit 0) — a WARNING, not blocking (defeating
  it needs a `ScriptKind`-selective 3-way divergence, outside the version-bump threat model), but
  closed anyway.

  **A third adversarial review found the resulting "complete 2×2 matrix" claim was FALSE, and
  BLOCKED on it.** `ScriptKind.TS` and `ScriptKind.TSX` are distinct `createSourceFile` arguments
  (enum values 3 and 4, selecting different grammars), not one mode with two names — and both
  `dead-wire-internal-use.mjs` and `tool-surfacing-extract.mjs` branch to `ScriptKind.TSX` for
  `.tsx` files (`filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS`). So the real
  callers span **three** `ScriptKind`s, not two, and Probe D left TSX unprobed on both axes.
  Executed: a stub correct on all four existing probe fixtures — including correctly keying its
  valid-TS response to `ScriptKind.TS` specifically, not just matching source text — but
  returning a degenerate tree for the identical valid-TS source parsed under `ScriptKind.TSX`,
  passed the seam cleanly (exit 0). The exploit itself was WARNING-class (zero tracked `.tsx`
  files today, `git ls-files "*.tsx"` = 0, so the branch is latent); what actually blocked was
  that this ADR asserted a **factually false completeness invariant** in a fail-closed safety
  seam's durable record — that must be corrected before ship regardless of the exploit's
  immediate severity.

  The seam now runs **five** probes for any caller that declared `createSourceFile`, each gated
  identically (never narrowed to a subset of callers) and each explicitly asserting its own
  required member before use (never folded into the outer gate, per the correction above):
  1. **Probe A** (malformed × JS) — `"const x = ;"`, explicit `ScriptKind.JS` as the 5th
     `createSourceFile` argument — matching `workflows-lint.mjs:140`'s real call shape exactly
     (corrected from an earlier 4-argument call that left `ScriptKind` `undefined`; see the
     call-shape-parity finding below).
  2. **Probe B** (malformed × TS) — `"interface Foo { bar: ; }"`, explicit `ScriptKind.TS` — a
     distinct diagnostic message ("Type expected." vs. Probe A's "Expression expected."),
     confirmed by invoking the real parser. Defeating both A and B requires special-casing two
     unrelated strings across two `ScriptKind`s, not one memorized answer.
  3. **Probe C** (valid × JS) — an AST-shape assertion: parse a known-VALID JS source
     (`"const y = 1;"`) under explicit `ScriptKind.JS` (matching `workflows-lint.mjs:140`'s real
     call shape; see the call-shape-parity finding below) and require both the exact expected
     statement count AND a non-zero `forEachChild` walk over it — the same API the three real
     callers use for their own AST walks — proving the tree is real and walkable, not merely that
     some object came back.
  4. **Probe D** (valid × TS) — mirrors Probe C for a known-VALID, type-annotated TS source
     (`"const y: number = 1;"`, explicit `ScriptKind.TS`, reusing the `ScriptKind.TS` presence
     already asserted for Probe B). (Aside, confirmed by invoking the real parser while choosing
     this fixture: this TS 6.x parser is lenient about type-annotation syntax even in JS mode —
     it emits no diagnostic either way — so no fixture is "TS-exclusive" at the diagnostic level.
     Probe D's value is exercising the TS-mode code path with realistic type-annotated input,
     matching the safety hooks' actual input domain — not diagnostic exclusivity, which this
     parser version doesn't offer.)
  5. **Probe E** (valid × TSX) — mirrors Probe D under explicit `ScriptKind.TSX`, reusing the
     identical `"const y: number = 1;"` fixture on purpose: the only variable this probe isolates
     is the `ScriptKind` argument itself, so a parser that keys correctly off source text but not
     off `ScriptKind` (the exact ATTACK 4 shape) cannot pass by accident. `ScriptKind.TSX` is
     explicitly asserted present, same discipline as `ScriptKind.TS`.

  **The accurate invariant, stated precisely:** the three real callers span exactly three
  `ScriptKind` values — `JS` (`workflows-lint.mjs`), `TS`, and `TSX` (the latter two, branched by
  `dead-wire-internal-use.mjs` and `tool-surfacing-extract.mjs` per file extension). All three are
  now probed on both the malformed-diagnostic axis (Probes A/B, JS/TS — TSX's diagnostic behavior
  is not separately probed; see Revisit-If) and the valid-AST-shape axis (Probes C/D/E, all three
  modes). `ScriptKind` is a closed TypeScript enum whose only other members — `JSX`, `JSON`,
  `Deferred`, `External`, `Unknown` — are used by **none** of the three callers, so this is a
  complete cover **by enumeration over the callers' actual usage**, not an assumption that no
  further mode exists in the abstract. As of the fourth adversarial review (below), each probe's
  `createSourceFile` call also matches its real caller's exact argument vector — arg count,
  `ScriptTarget`, `setParentNodes`, and `ScriptKind` — verified directly against all three
  consuming scripts' call sites, not assumed from the `ScriptKind` coverage alone.

  **A fourth adversarial review found the most severe gap of this migration — a LIVE silent pass,
  not a latent one, proven by execution.** Every prior finding on this axis was about *which*
  `ScriptKind` value a probe used; this one is about whether a probe's `createSourceFile` call uses
  the **same argument vector** — arg count, `ScriptTarget`, `setParentNodes`, and `ScriptKind`
  together — as its real caller. Probe C (valid × JS shape) called `createSourceFile` with only 4
  arguments, leaving `scriptKind` `undefined`. But `workflows-lint.mjs:140`, the probe's real
  caller, **always** passes `ts.ScriptKind.JS` explicitly as a 5th argument — never omits it, even
  though the parameter is optional. Probe A (malformed × JS) had the identical 4-vs-5-argument gap
  on the diagnostic axis. Executed: a stub correct on every probe exactly as the seam issued it
  (including keying valid/malformed JS to `scriptKind === undefined`, matching Probes A/C's pre-fix
  calls, and TS/TSX correctly to their explicit values) but degenerate for the *same* source parsed
  under explicit `ScriptKind.JS` passed the seam cleanly (exit 0) — then, replaying
  `workflows-lint.mjs:140`'s exact call shape against that stub on real workflow source, produced
  `statements.length: 0` and zero `forEachChild` children. A parser drift keying degeneracy off
  omitted-vs-explicit `ScriptKind.JS` would make `workflows-lint` — which lints
  `workflows/canon-probe.js` and `workflows/canon-waves.js` today — silently pass every ban rule on
  both tracked files, **today**, not hypothetically. Strictly more severe than the TSX finding
  (which had zero tracked `.tsx` files to affect).

  Fixed by making Probe A and Probe C issue `createSourceFile` with the exact argument vector
  `workflows-lint.mjs:140` uses: `ts.ScriptTarget.Latest`, `true`, and `ts.ScriptKind.JS` explicit
  as the 5th argument — asserted present once (reusing the existing per-member presence-assertion
  discipline), not folded into the outer gate. The class-level question this raised — does *every*
  probe's call shape match its real caller's, on every argument — was checked directly against all
  three consuming scripts (`workflows-lint.mjs`, `dead-wire-internal-use.mjs`,
  `tool-surfacing-extract.mjs`), not inferred:

  | Probe | Axis | Real caller(s) | Caller's call (fileName, src, target, setParentNodes, scriptKind) | Probe's call (same params) | Parity |
  |---|---|---|---|---|---|
  | A | malformed × JS | `workflows-lint.mjs:140` | `(filePath, src, ScriptTarget.Latest, true, ScriptKind.JS)` | `(fixture, "const x = ;", ScriptTarget.Latest, true, ScriptKind.JS)` | Fixed this round (was 4-arg, `ScriptKind` omitted) |
  | B | malformed × TS | `dead-wire-internal-use.mjs:142`, `tool-surfacing-extract.mjs:149` | `(filePath, src, ScriptTarget.Latest, true, scriptKind∈{TS,TSX})` | `(fixture, "interface Foo { bar: ; }", ScriptTarget.Latest, true, ScriptKind.TS)` | Already matched |
  | C | valid × JS | `workflows-lint.mjs:140` | same as A | `(fixture, "const y = 1;", ScriptTarget.Latest, true, ScriptKind.JS)` | Fixed this round (was 4-arg, `ScriptKind` omitted — **the live exploit**) |
  | D | valid × TS | `dead-wire-internal-use.mjs:142`, `tool-surfacing-extract.mjs:149` | same as B | `(fixture, "const y: number = 1;", ScriptTarget.Latest, true, ScriptKind.TS)` | Already matched |
  | E | valid × TSX | `dead-wire-internal-use.mjs:142`, `tool-surfacing-extract.mjs:149` (TSX branch) | same as B (TSX branch) | `(fixture, "const y: number = 1;", ScriptTarget.Latest, true, ScriptKind.TSX)` | Already matched |

  All three real callers use `ts.ScriptTarget.Latest` and `setParentNodes: true` uniformly — the
  only argument that ever diverged between a probe and its caller was `ScriptKind`, and only for
  Probes A and C (both tied to the JS caller). Probes B, D, and E already issued 5-argument calls
  with the caller's exact explicit `ScriptKind`; that was verified, not assumed, by re-reading the
  three consuming scripts' call sites directly. **After this fix, no probe can be distinguished
  from its real caller by any `createSourceFile` argument** — this closes the argument-vector-parity
  class this build kept finding one `ScriptKind` at a time, not merely this one instance of it.

  See `mcp-server/src/__tests__/ts-compiler-seam.test.ts` ("Case A" / "Case B" for the gating
  correction; "Case C" / "Case D" for the first hardening round's two probes; "Case E" for ATTACK
  4 / Probe D; "Case F" for the TSX finding / Probe E; "Case G" for the call-shape-parity finding /
  Probes A+C) for the regression tests covering all seven failure shapes. **This still does not
  make the pin self-verifying against every possible future
  degradation** — it closes every demonstrated class to date, over the `ScriptKind` values the
  callers actually invoke. Any future `typescript-parser` version bump should re-run these probes
  (they run automatically, for any caller that parses, on every invocation of the three scripts)
  and, ideally, re-run the adversarial stub tests manually as a spot-check that the probes still
  discriminate real from degraded. **On overhead**: the probe computation itself is negligible —
  measured in-process at ~1.5ms for all five probes combined once the parser module is loaded.
  Real per-invocation wall-clock time is dominated by the fixed cost of importing the ~30MB pinned
  `typescript-parser` package (present since this ADR's first version, not something the probes
  add), which varies with ambient system load rather than with probe count.
- A second, dev-only copy of TypeScript ships in `node_modules` (~30MB), used only by the three
  lint/gate scripts.
- **The repo-root `tsconfig.json` required the same `baseUrl` removal, with one deliberate
  deviation from a literal per-alias translation, to preserve `loadPathAliases`'s behavior
  exactly.** `mcp-server/src/shared/lib/paths.ts`'s `loadPathAliases` reads the root
  `tsconfig.json` as plain JSON (not through `tsc`) to resolve `@alias` imports for the knowledge
  graph, combining `paths` + `baseUrl` itself via `parseTsconfigPaths`. The pre-migration root
  config's `"@/*": ["*"]` entry has a latent quirk: `parseTsconfigPaths` only recognizes targets
  ending in `/*`, and the bare `"*"` value does not — so this entry has **always** contributed
  zero aliases to `loadPathAliases`'s output (unlike the other 8 named aliases, which do resolve).
  Zero files in the repo import the bare `@/` prefix. A literal per-alias translation (mirroring
  the other 8: `"@/*": ["./mcp-server/src/*"]`) would have newly matched the `/*`-suffix check and
  introduced a `@/` alias that does not exist today — a real behavior change violating AC7, and
  the opposite of what this migration promises for `src/**`. **Deliberately omitted the `@/*` key
  from the root config's `paths` instead** — proven, not assumed: a throwaway probe computed
  `parseTsconfigPaths`'s output for the old (`baseUrl`-based) and new (relative, `@/*`-omitted)
  configs and confirmed byte-identical results for all 8 real aliases, with the `@/` gap preserved
  on both sides. Locked in as a permanent regression test:
  `mcp-server/src/shared/lib/__tests__/paths.test.ts`.
- `workflows-lint` and `tool-surfacing-extract` are syntax-only consumers that *could* eventually
  move to a lighter, TypeScript-free parser (e.g. `oxc-parser`/`@swc/core`) without needing the
  pin at all — but `dead-wire-internal-use.mjs` cannot follow them, because its question (same-file
  lexical binding + declaration-space resolution, distinguishing `type Thing` from `const Thing`)
  is not answerable by a syntax-only parser. This split was evaluated during design (D4/D6/D7 in
  this build's `DESIGN.md`) and explicitly deferred — not solved here — because it would couple a
  dependency-version bump to a tooling re-architecture. **This is BLOCKED, not backlog**: the only
  measured path to retire the pin for `dead-wire` is TS 7's own `noUnusedLocals` diagnostic (rides
  the TS 7 binary, no separate JS API) or the `unstable/sync` `Checker.getSymbolAtLocation` IPC
  path — both require TS 7's `unstable/` API surface to stabilize first, which is an external event
  this project does not control.

## Revisit-If

- **The malformed-diagnostic axis (Probes A/B) covers `ScriptKind.JS` and `.TS` but not `.TSX`
  separately** — only the valid-AST-shape axis (Probes C/D/E) was extended to all three modes in
  this round, per the reviewing scope that motivated it. `.tsx` files are syntactically a superset
  of `.ts` (JSX productions added on top), so a `.ts`-mode malformed-diagnostic fixture failing to
  parse is expected to fail identically under `.tsx` mode for the same reason — but this has not
  been separately probed the way the valid-shape axis now is. Revisit if a future adversarial pass
  finds a `ScriptKind.TSX`-specific diagnostic-reporting gap, or add a Probe F (malformed × TSX)
  proactively if the cost of doing so ever becomes cheap relative to the residual risk.
- **TS 7's API drops the `unstable/` namespace** (i.e. the compiler API is declared stable). At
  that point, re-evaluate whether `unstable/sync`'s `Checker.getSymbolAtLocation` (reachable today
  only through the API→Project→Program→Checker IPC graph) can replace the pinned TS 6 parser for
  `dead-wire-internal-use.mjs` specifically — the one consumer whose question (same-file binding
  resolution) is not syntax-only and so cannot move to a lighter parser regardless of `unstable/`'s
  status.
- **`workflows-lint` and `tool-surfacing-extract`** could move off the pin independently and sooner
  — they are syntax-only AST-walk consumers over our own JS/TS source. A future build could adopt
  `oxc-parser`/`@swc/core` for these two without waiting on TS 7's API stabilization, narrowing the
  pin's scope to `dead-wire` alone. Not adopted here to avoid coupling a dependency bump to a
  tooling re-architecture (`scope-discipline`).
- **`tsc --noUnusedLocals`** is the single real future path that could retire the pin for
  `dead-wire` entirely without waiting on `unstable/*` — probed and recorded as viable but carrying
  a fail-open landmine (a symbol that is a file's *only* export becomes a script global when
  `export` is stripped in-memory, and `noUnusedLocals` does not flag unused globals) and requiring
  a fully valid whole-program typecheck rather than today's single-file, no-lib Program. A future
  build adopting this path must close that landmine (e.g. injecting `export {};`) before switching.
