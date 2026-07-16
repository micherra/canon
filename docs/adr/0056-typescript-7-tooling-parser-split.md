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

All three are fail-closed safety gates. The probe additionally found: `tsconfig.json`'s `baseUrl`
+ non-relative `paths` aliases are rejected outright by TS 7 (`TS5102`/`TS5090`); the breakage tail
was NOT bounded to the two symptoms the PRD started from (two more broken scripts, 49 downstream
test failures, masked by CI's `lint` job failing first and short-circuiting `build`/`test`); and
TS 7's surviving `unstable/*` API is an IPC client to a Go server process, `Project`/`Program`
oriented, with **no string→AST parse entry point at all** — there is no way to migrate the three
scripts onto TS 7's own API without spawning a Go server per lint invocation against an
explicitly-unstable interface.

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
  assertion passes, for any caller that declared `createSourceFile`/`ScriptTarget`/`ScriptKind`,
  the seam itself parses a known-malformed source and requires a populated `parseDiagnostics`
  array, `fail()`-ing otherwise — closing the gap structurally rather than relying on each
  caller's own downstream check. The three callers' own `parseDiagnostics` derefs were also
  hardened from short-circuiting (`?? []`, `if (parseDiags && ...)`) to positive
  assert-and-fail, so a contract violation past the probe is still loud, not silently skipped.
  See `mcp-server/src/__tests__/ts-compiler-seam.test.ts` ("surface-complete, parseDiagnostics
  unreported" case) for the regression test. **This does not make the pin self-verifying against
  every possible future degradation** — it closes the one demonstrated class. Any future
  `typescript-parser` version bump should re-run this probe (it runs automatically on every
  invocation of the three scripts) and, ideally, re-run the adversarial stub test manually as a
  spot-check that the probe itself still discriminates real from degraded.
- A second, dev-only copy of TypeScript ships in `node_modules` (~30MB), used only by the three
  lint/gate scripts.
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
