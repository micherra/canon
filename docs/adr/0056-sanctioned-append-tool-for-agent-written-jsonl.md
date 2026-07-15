---
adr: "0056"
title: "Sanctioned append tool for agent-written JSONL"
status: accepted
date: "2026-07-15"
build: "fix-the-learningjsonl-non-atomic-append-bug-that-concatenated-two"
---

# ADR-0056: Sanctioned append tool for agent-written JSONL

## Context

`.canon/learning.jsonl` line 65 (later re-verified at line 63 as the corpus
grew) held two merged records — `Unexpected non-whitespace character after
JSON at position 1522`. PROBE-FINDINGS.md P1 reproduced the mechanism
exactly: a predecessor append that omits its trailing newline leaves the
file's last line "open," and the *next* append — even a perfectly correct
one — lands on that open line and the two records merge into one
unparseable line. P4 ruled out concurrency (200 concurrent appends, 0
merges); this is not a race.

P2/P3 identified the writer: the only code call site
(`reconcile-learnings.ts:642`) is already correct and post-dates the
corruption by roughly six weeks. The real writers are **agents executing
freeform Bash** against four prose instruction sites (`learner-dimensions.md`,
`analyze-patterns/SKILL.md`, `review-learnings.md`, `writer.md`), none of
which specify newline-termination or a mechanism. Each agent improvises its
own shell idiom; one, on 2026-06-04, improvised one without a trailing
newline.

This means there is no code bug to patch — prose cannot bind an agent's
ad-hoc shell command, and asking an agent to "remember to append `\n`" is a
request for vigilance, which is a defect generator, not a fix.

## Options Considered

### Option A: Prose hardening only (v1 scope)

Document the safe shell idiom (`printf '%s\n' "$json" >> file`) at all four
prose sites, plus a self-healing predecessor-repair helper for defense in
depth. No new MCP tool.

**Pros:**
- Minimal surface — no new tool contract, no new agent grants.
- Ships fast.

**Cons:**
- Still asks an agent to get a byte-level shell idiom right, every time,
  across four independently-maintained prose sites. The exact failure mode
  this ADR exists to close.
- No enforcement — a future prose edit can silently drop the safe idiom
  again with no gate to catch it.

**Canon-principle alignment:** tensions `fail-closed-by-default` (the safety
property depends entirely on an agent's shell-idiom discipline, which is
not a closed system) and `simplicity-first` only in the narrow sense of
avoiding a new tool — but the risk it leaves open is the size of the actual
problem.

### Option B: PreToolUse guard hook blocking `>>` to `.canon/*.jsonl`

A fail-closed Bash-inspecting hook that blocks any raw shell append to a
`.canon/*.jsonl` path, forcing agents through a sanctioned mechanism.

**Pros:**
- Would be the only option that structurally closes the bypass path
  entirely (see Option C's residual, below).

**Cons:**
- Rejected on first-hand evidence gathered in this session, not
  speculation: the existing `push-to-main-guard.sh` PreToolUse hook blocked
  a genuinely benign probe command mid-session — `echo "--- line count:
  $(wc -l < p1.jsonl) ---"` was refused with *"a command substitution is
  followed by further command tokens — cannot prove it does not resolve to
  'git push' — blocking fail-closed."* There was no `git` anywhere in the
  command. A fail-closed Bash-inspecting hook cannot prove absence of
  intent inside `$(...)`, so it blocks legitimate work. A `>>`-detector for
  `.canon/*.jsonl` inherits this exact hazard class, and lands on the
  `canon-safety-hooks` sensitive path (ADR-0044 floor).

**Canon-principle alignment:** honors `fail-closed-by-default` in the
narrow sense of closing the gap completely, but the false-positive cost
measured first-hand in this very build makes the cure worse than the
residual it would eliminate.

### Option C: Sanctioned `append_learning_record` MCP tool (chosen)

A tool that takes a structured `record` object and a `project_dir`; the
tool itself serializes and newline-terminates the record via a new
newline-healing primitive (`appendJsonlLine`,
`@shared/lib/jsonl-append.ts`). The agent hands over an object and never
touches bytes.

**Pros:**
- Removes the failure mode from the agent's reach structurally — there is
  no byte-level control left for an agent to get wrong, unlike Option A's
  vigilance-based fix.
- The primitive protects the tool's *own* correct append too: P1's
  corollary shows an innocent, correct append still corrupts when it lands
  on a newline-less predecessor left by a historical or bypassing writer.
  Healing (not just serializing) is required even for a perfectly-formed
  caller.
- No new hazard class — unlike Option B, this adds an affordance rather
  than a Bash-inspecting block, so it does not inherit the command-
  substitution false-positive problem.

**Cons:**
- A residual bypass remains: both grantee agents (`learner`, `writer`) also
  grant `Bash`, and nothing mechanically stops an agent from running
  `printf ... >> .canon/learning.jsonl` and ignoring the tool. See
  Consequences.
- New tool contract, two new agent grants, a pinned tool-count test, and a
  fail-closed tool-surfacing gate (`hooks/tool-surfacing-check.sh`) that
  requires registration and grant to land together — real ongoing
  maintenance surface, unlike Option A.

**Canon-principle alignment:** honors `fail-closed-by-default` in the
direction that matters most here — the tool fails closed on what it
controls (invalid `project_dir`, an unserializable record) and *heals*
rather than throws on a bad predecessor, because throwing would strand the
very record the caller asked to persist, turning a cosmetic scar into data
loss. Honors `validate-at-trust-boundaries` (barrier as the handler's first
statement). Tensions `simplicity-first` consciously — a ~30-line helper
became a full tool contract — accepted to close the enforcement hole
Option A cannot close.

## Decision

Chosen: **Option C — Sanctioned `append_learning_record` MCP tool**.

The core justification is that Option A cannot close the actual gap (prose
cannot bind a freeform-Bash agent) and Option B closes it at a cost already
measured, first-hand, to be worse than the defect it would prevent. Option
C converts the failure mode from "an agent must remember a byte-level shell
idiom, forever, across four prose sites" into "an agent hands over an
object" — a structural fix, not a vigilance fix — while adding no new
Bash-inspection hazard.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `fail-closed-by-default` | honors (resolved in two directions) | Fails closed on what the tool controls: invalid `project_dir` → `INVALID_INPUT`; an unserializable record → `INVALID_INPUT`. Heals — does not throw — on a bad predecessor, because throwing would strand the very record the caller asked to persist. |
| `validate-at-trust-boundaries` | honors | `isSafeProjectDirInput` (ADR-0030) runs as the handler's first statement, before any filesystem access — the same pattern `reconcile-learnings.ts:702` already uses. |
| `simplicity-first` | tensions, consciously accepted | A ~30-line helper (v1 scope) became a full tool contract with registration, two agent grants, and a pinned tool-count test. Accepted because prose hardening alone (Option A) cannot close the actual gap. |
| `no-dead-abstractions` | honors | The primitive has two real callers (the tool, `reconcile-learnings.ts`); the tool has two real grantees (`learner`, `writer`). No speculative config or unused options. |
| `agent-never-trust-overlay-tier` | honors | No target-path parameter — see Consequences. A caller-supplied path would be reachable by overlay-influenced content and would turn a narrow append seam into a general arbitrary-file-append primitive. |

## Consequences

**Positive:**
- Every tool-mediated and code-mediated append to `learning.jsonl` is now
  newline-safe and self-healing; a single bypassing append no longer
  permanently corrupts the file — the next tool-mediated append heals the
  open line and reports `healed: true`, an observability signal that
  someone bypassed the tool.
- The primitive (`appendJsonlLine`) is reusable by any future JSONL
  producer with the same shape of problem, without inheriting
  `atomic-write.ts`'s rename-replaces-file semantics (which are wrong for
  append-only data).

**Negative / trade-offs:**
- **Named residual (accepted, not eliminated):** both grantee agents retain
  `Bash`. Nothing mechanically stops an agent from running
  `printf ... >> .canon/learning.jsonl` directly, ignoring the tool
  entirely. What the tool buys precisely: with healing in place, a single
  bypassing append no longer corrupts anything permanently. Permanent
  corruption now requires **two consecutive tool-bypassing appends** — one
  omitting `\n`, then a naive one landing on it — down from one. This is a
  large reduction, not elimination. `jsonl-02` (doctor Check 9, prose
  hardening at the four sites) is the compensating detection net for this
  residual, not a second enforcement mechanism.
- New ongoing maintenance surface: the pinned tool-count characterization
  test (`create-server.test.ts`) and the fail-closed
  `hooks/tool-surfacing-check.sh` gate both require this tool's
  registration and its two agent grants to move together — a future
  refactor that touches either without the other strands the tree
  gate-red.

## Revisit-If

- The residual bypass (an agent hand-rolling `>>` despite the tool) is
  observed in practice — e.g. `healed: true` telemetry recurs, or doctor
  Check 9 flags a fresh merge — at a rate that makes the accepted risk in
  Consequences no longer acceptable. At that point, revisit Option B with
  a narrower, path-scoped guard (rather than a general command-substitution
  inspector) now that the false-positive class from this session is
  documented and could inform a tighter design.
- A second JSONL store (beyond `learning.jsonl`) gains a live agent writer
  following the same freeform-Bash pattern — extend the tool (or add a
  sibling) rather than let prose-only guidance re-accumulate the same gap.
