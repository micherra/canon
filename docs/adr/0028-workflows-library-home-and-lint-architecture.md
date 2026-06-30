---
adr: "0028"
title: "workflows/ library home, node-AST lint via hooks/lint.sh, and scriptPath discovery for Inc 0"
status: accepted
date: "2026-06-29"
build: "workflow-integration-epic-increment-0-canon-probe-canary-workflow-ci"
---

# ADR-0028: workflows/ library home, node-AST lint via hooks/lint.sh, and scriptPath discovery for Increment 0

## Context

The ratified workflow-integration design (`docs/explore/workflow-integration/SYNTHESIS.md`,
2026-06-07) commits Canon to a saved-workflow library at `workflows/` (installed to
`.claude/workflows/`), guarded by a CI lint that bans the harness-forbidden constructs in
workflow scripts. Increment 0 is the foundational slice: the `canon-probe` canary + that lint,
nothing else.

Three coupled decisions must be made now because they shape every later increment and are
awkward to reverse once a library and CI depend on them:

1. **Where the lint lives and how it parses** workflow scripts. SYNTHESIS §3.1 names
   "`node --check`, meta-literal lint, banned-API lint, isolation grep-ban" — but empirical
   probing (this build's `PROBE-FINDINGS.md`) showed `node --check` **false-fails** the
   legitimate workflow module shape (top-level `export` + top-level `return` + top-level
   `await`): as a real node ESM module it raises `Illegal return statement`. The parse gate
   must tolerate the Workflow sandbox's wrapped-async shape while still catching genuinely
   malformed JS and the banned constructs.
2. **Where the `workflows/` source-of-truth lives** and how it relates to the harness's
   `.claude/workflows/` name-resolution directory.
3. **How canon-probe is discovered/invoked in Increment 0** without building an install
   pipeline that exceeds the deliberately-small Inc-0 scope.

Constraints: Canon already has an established "shell gate wraps a node helper that imports the
repo's `typescript`" pattern (`hooks/dead-wire-gate.sh` + `mcp-server/scripts/dead-wire-internal-use.mjs`),
and an established managed-artifact-class pattern (`loops/`, `routines/` at repo root, each with
a `CLAUDE.md` + `README.md`). The verify path is `npm run build → lint → test → bash hooks/lint.sh
→ bash hooks/dead-wire-gate.sh`; the CI `shell` job already runs `bash hooks/lint.sh` after
`npm ci` in `mcp-server`.

## Options Considered

### Option A: Pure-shell lint (grep + `node --check`) wired into hooks/lint.sh

**Pros:**
- No node helper; lives entirely in the existing shell lint surface.

**Cons:**
- `node --check` is unusable here — it false-fails the legit top-level-`return` workflow shape
  (PROBE-FINDINGS Probe 3).
- Grep cannot reliably distinguish argless `new Date()` from `new Date(args.ts)`, verify
  `meta`-literal purity, or detect TS syntax without false-firing on tokens inside strings and
  comments.

**Canon-principle alignment:** tensions `hooks-fail-closed`'s spirit (an imprecise gate that
silently mis-classifies is worse than a precise one); weak on `information-hiding` (ban
knowledge smeared across regexes).

### Option B: Node-AST lint helper (TS compiler API) wrapped by a fail-closed shell gate, wired into hooks/lint.sh; workflows/ at repo root; scriptPath discovery for Inc 0

**Pros:**
- The TS-compiler-API AST walk is empirically proven to detect every banned construct
  precisely, including argless-`new Date()` vs with-arg, and to tolerate the workflow sandbox
  shape via `ts.parseDiagnostics` (PROBE-FINDINGS Probes 2,4).
- Reuses the exact `typescript` dep and the shell-gate-wraps-node-helper pattern the dead-wire
  gate already established; CI installs that dep already.
- Wiring via a `check_workflows_lint()` function in `hooks/lint.sh` lands the gate in BOTH the
  local verify path and CI with zero new CI YAML.
- `workflows/` at repo root mirrors `loops/`/`routines/` (consistent managed-artifact-class home).
- `scriptPath` invocation runs canon-probe from disk today with no install pipeline.

**Cons:**
- Adds a node helper (more moving parts than pure shell).
- Inc-0 canon-probe is not yet resolvable by `name` (needs the deferred `.claude/workflows/`
  install).

**Canon-principle alignment:** honors `hooks-fail-closed` (gate exits non-zero when node/
typescript absent), `information-hiding` (ban list in one file), `functions-do-one-thing`
(decomposed helper), and the "no workflow without a consumer" admission rule (canon-probe ships
with its lint consumer + invocation doc).

### Option C: CI-YAML-only lint step (no local gate); author canon-probe directly in .claude/workflows/

**Pros:**
- canon-probe immediately `name`-resolvable; no node helper if a CI action does the parsing.

**Cons:**
- Violates PRD AC#4 (lint must run in the LOCAL verify gate too), so drift is caught only at
  push time.
- Authoring directly in `.claude/workflows/` abandons the SYNTHESIS `workflows/`-source model
  and makes dev vs install diverge.

**Canon-principle alignment:** tensions the deterministic-gate-runs-in-every-tier invariant
(local gate skipped) and the managed-artifact-class consistency.

## Decision

Chosen: **Option B.**

The lint is a node-AST helper (`mcp-server/scripts/workflows-lint.mjs`, importing the repo's
`typescript`) wrapped by a fail-closed shell gate (`hooks/workflows-lint.sh`) and wired into
`hooks/lint.sh` via `check_workflows_lint()`. The parse gate uses `ts.parseDiagnostics`, NOT
`node --check`. The source-of-truth library lives at `workflows/` (repo root, mirroring
`loops/`/`routines/`, with `CLAUDE.md` + `README.md`). For Increment 0, canon-probe is invoked
on demand via `Workflow({ scriptPath: "workflows/canon-probe.js" })`; the harness's name-based
`.claude/workflows/` resolution and its install/sync pipeline are **deferred to Increment 1**
(the args-envelope / library increment), where they belong.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| hooks-fail-closed | honors | The shell gate exits non-zero when node or typescript is absent, or on any helper error — it never silently passes. |
| information-hiding | honors | The banned-construct knowledge lives only in `workflows-lint.mjs`; the shell gate, lint.sh, and test depend only on its exit contract. |
| functions-do-one-thing | honors | Helper decomposed into parse / walkBans / checkMetaLiteral / lintFile / main. |
| leave-touched-files-better | honors | The `hooks/lint.sh` edit matches the existing install-faithfulness-check structure. |
| (SYNTHESIS §3.1 literal "node --check") | tensions, justified | Deviates because `node --check` false-fails the legit workflow shape (PROBE-FINDINGS Probe 3); `ts.parseDiagnostics` is strictly more correct. |

## Consequences

**Positive:**
- The library is valid-by-construction from its first file, locally and in CI, with no new CI YAML.
- The lint is precise (no grep false-positives) and reuses proven infrastructure.
- Inc 0 stays genuinely small — no boot/session-hook changes for an install pipeline.

**Negative / trade-offs:**
- Until Inc 1 lands the `.claude/workflows/` install, canon-probe is invocable only via
  `scriptPath`, not by `name`.
- The lint depends on `mcp-server/node_modules/typescript` being installed (already true in CI
  and local dev); the gate fails closed if it is not.

## Revisit-If

- Increment 1 builds the `.claude/workflows/` install/sync pipeline → revisit the
  scriptPath-only discovery decision (promote canon-probe to name-resolution; extend the lint
  to also cover the installed copy if it can diverge).
- The Workflow runtime changes its module shape such that `node --check` (or another host-native
  validator) becomes faithful → reconsider the parser choice.
- A future workflow legitimately needs a construct currently banned by the lint → the ban list
  is centralized in one file and can be amended there with a recorded rationale.
