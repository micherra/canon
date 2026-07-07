# ADR-0042: Corpus-drift enforcement gates are precision-first (fail-closed on a verified-clean scope, narrow high-signal idioms, inline suppression)

- Status: Accepted
- Date: 2026-07-06
- Deciders: architect (corpus-optimization #462 follow-ups build)
- Related: sug_BLOAT1, sug_PHANTOMID1, sug_RULEPARITY1; ADR-0027 (untrusted overlay);
  `hooks/dead-wire-gate.sh` (sibling reachability gate + `canon:allow-unwired` idiom)

## Context

PR #462's corpus audit surfaced three drift classes that recur silently: byte-identical
scaffold boilerplate across principles, phantom principle-id citations in agent/rule
prose, and `scope: agents: all` rules wired to zero agents. The learner filed three
suggestions (sug_BLOAT1 / PHANTOMID1 / RULEPARITY1) and explicitly framed the first two
as **detection aids, "not build-blocking gates"** — because a byte-identical span "is not
inherently wrong on day one," and prose-token matching "is necessarily heuristic." The
user, however, chose to wire all three into the verify chain / CI shell suite, where a
gate's whole purpose is to **block**. AC #1/#2/#3 require non-zero exit on a violation.

This is a genuine tension: an always-blocking gate on a corpus that STILL contains
pre-existing instances would fail on day one (and fixing all pre-existing debt is out of
scope); a heuristic prose scanner run broadly produces dozens of false positives
(measured: 54+ unresolved backtick tokens like `ts-ignore`, `no-unused-vars`,
`eslint-disable`). Either failure mode makes the gate get disabled.

## Decision

All three gates adopt a single **precision-first** posture with three components:

1. **Fail-closed on a VERIFIED-CLEAN scope.** Each gate is scoped to a surface empirically
   confirmed clean at authoring time (built-in `principles/{rules,strong-opinions,
   conventions}` tree for Gate A — `.canon/` overlay and `.claude/` indexes excluded; the
   `loaded`-conditional idiom for Gate B; structured `scope.agents` frontmatter for Gate
   C). Because the scoped surface is clean today, fail-closed blocks only NEW drift — which
   reconciles the learner's "don't retroactively block" caveat with the user's "must block"
   AC. Two same-build cleanups (reviewer.md phantom reword, evaluator rule wiring) bring
   the last pre-existing instances to zero so the gates exit 0 on merge.

2. **Narrow, high-signal idioms over recall.** Gate B validates ONLY the
   `` `<id>` is loaded `` principle-conditional idiom (5 hits, 0 false positives) rather
   than all backtick or all `(e.g., …)` citations (54+ false positives). This matches the
   learner's own "start narrow" instruction and trades recall (may miss exotic phantom
   forms) for zero false positives (the gate stays enabled and trusted).

3. **Inline suppression escape hatch**, mirroring `dead-wire-gate.sh`'s
   `// canon:allow-unwired`: `<!-- canon:allow-shared-span: … -->` (Gate A) and
   `<!-- canon:allow-unshipped-principle-id: … -->` (Gate B) let a future author opt a
   legitimate case out without weakening the gate globally.

Gates run **offline** (filesystem/awk id-resolution, no `list_principles` MCP) because CI
has no Canon daemon.

## Consequences

- **Positive:** the gates are trustworthy (no false-positive fatigue), block real new
  drift, and require no large brittle allowlist. Gate B surfaced a second, previously
  undiscovered phantom (`thin-handlers`) on its first design run — evidence the narrow
  idiom still has real recall for the demonstrated defect shape.
- **Negative / accepted:** recall is deliberately incomplete. Gate B misses phantom
  citations outside the "loaded" idiom (e.g. bare checklist bullets); Gate A misses
  drift in the excluded `.canon/` overlay and non-Anti-Rationalization scaffold blocks.
  Broadening any gate later must re-run the false-positive probe and seed suppressions —
  it is not a free change, which is why this posture is recorded here.
- **Reversal cost (why this is an ADR):** reversing to a recall-first posture would
  reintroduce the 54+ false positives the probe measured and, historically, get the gate
  disabled — so the narrow scope is a load-bearing, hard-to-reverse stance, not an
  incidental implementation detail.

## Alternatives considered

- **Advisory (always exit 0 + warn):** matches the learner's literal "not blocking"
  framing but violates AC #1/#2/#3 ("non-zero on a violation") and lets new drift merge.
  Rejected.
- **Fail-closed on the whole corpus incl. `.canon/`:** fails on day one (overlay still
  carries a duplicate span) and would force out-of-scope principle rewrites. Rejected.
- **Broad recall-first Gate B with a large allowlist:** 54+ seed entries, brittle,
  false-positive-prone, high maintenance. Rejected in favor of the narrow idiom +
  targeted suppression.
