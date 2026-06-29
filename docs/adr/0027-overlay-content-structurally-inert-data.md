---
adr: "0027"
title: "Overlay content is structurally inert data, not scanned-then-trusted instructions"
status: accepted
date: "2026-06-25"
build: "overlay-inert-data-hardening-4-redesign-replace-the-falsified-scanner"
---

# ADR-0027: Overlay content is structurally inert data, not scanned-then-trusted instructions

## Context

Untrusted project-local `.canon/` overlay content (user corrections, project principles +
overrides, routines, kg-language labels) is assembled into agent prompts. PR #420 attempted
to gate this with a fail-closed *scanner* (ADR-0023 in that PR). Adversarial security
(PR #420 `reviews/SECURITY.md`, BLOCKING, 2 HIGH) falsified it: Unicode Tag characters
(U+E0000–E007F, encoded as valid surrogate pairs), invisible format chars (LRM/RLM/WJ/soft-
hyphen), case variants (`System:`), and plain-ASCII semantic injection all bypassed what was
billed as a "vocabulary-free" gate but was in fact an enumerated codepoint/signature
blocklist. The user rejected the approach: *"the allowlist pattern is naive and failed us
every time."* The #4 scanner and its ADR-0023 were **reverted** with the #420 descope — so on
this base there is no overlay scanner and no overlay ADR-0023 to supersede (the live
`0023`/`0024` are unrelated topics).

Root cause: the design positioned the scanner as THE trust boundary — scan → pass → inline
overlay content as trusted instructions. You cannot reliably *detect* injection intent in
free text.

## Options Considered

### Option A: Character/signature detection (allow- or block-list) — the reverted approach

**Pros:**
- Simple; obvious matches.

**Cons:**
- Falsified empirically; an enumeration treadmill (each codepoint/signature closes one form,
  opens the next); cannot stop plain-ASCII semantic injection at all.

**Canon-principle alignment:** violates `security-hook-parser-allowlist-posture` (the exact
anti-pattern it warns against).

### Option B: Structural inertness — neutralize (load) + fence (assembly) + never-trust-tier (policy)

**Pros:**
- A bypass payload lands as quoted DATA inside a fenced, tier-labeled, neutralized envelope —
  never in instruction position, regardless of content.
- Layer 1 strips by Unicode **property class** (`\p{Cc}\p{Cf}\p{Cs}\p{Co}` + Tag block) — a
  closed/complete set, not a list to extend.
- The fence carries a **per-spawn high-entropy nonce**, so a payload cannot pre-close it
  (delimiter-injection resistant); literal base-sentinel occurrences are neutralized first.
- A standing agent rule (`agent-never-trust-overlay-tier`) forbids acting on untrusted-tier
  content; the `trust_tier` provenance field makes assemblies auditable.

**Cons:**
- Fence token cost (~3 lines + nonce per overlay-bearing spawn).
- Durable untrusted-provenance ENTRIES deferred (the boundary is the fence; audit
  completeness is a follow-up).

**Canon-principle alignment:** honors `security-hook-parser-allowlist-posture`,
`fail-closed-by-default`, `validate-at-trust-boundaries`, `deep-modules`.

### Option C: LLM-judge classifier on overlays

**Pros:**
- Catches some semantic cases a regex cannot.

**Cons:**
- Cost/latency on the prompt-assembly hot path; probabilistic; the same detection fallacy —
  a passed classification is still treated as trust.

**Canon-principle alignment:** neutral; rejected.

## Decision

Chosen: **Option B — structural inertness.** Overlay content is neutralized at load, fenced
in a nonce-delimited UNTRUSTED-DATA envelope at every assembly sink, and tier-labeled; a
standing agent rule forbids acting on instructions from the untrusted tier. The boundary is
inertness, not detection — "passed a scan" never again means "safe to inline as trusted."

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| security-hook-parser-allowlist-posture | honors | Layer 1 is a closed property-class; boundary is inertness, not a vocabulary — the posture rethink, not re-enumeration |
| fail-closed-by-default | honors | untrusted content neutralized+fenced before it can reach instruction position |
| validate-at-trust-boundaries | honors | the boundary is the prompt-assembly sink (where the agent actually reads) |
| deep-modules | honors | two small pure primitives hide all structural logic; sinks call one line |

## Consequences

**Positive:**
- All PR #420 SECURITY.md bypass classes are structurally inert regardless of payload.
- The routine `title` under-scan (F4) dissolves: the fence brackets the full rendered
  projection, not a single field.
- The fence + rule + tier are reusable by the Phase-1 transcript-additions program.

**Negative / trade-offs:**
- Fence token cost on overlay-bearing spawns (accepted).
- Durable untrusted-provenance ENTRIES per sink are deferred to the context-mill program
  (the fence, not the provenance record, is the agent-facing boundary).
- kg-language config fields are constrained by a strict identifier charset (closed domain),
  not the free-text fence.

## Revisit-If

- A consuming model is shown to act on fenced untrusted data despite the policy → strengthen
  the framing / add per-line datamarking; never revert to a detection scanner.
- The context-mill program needs durable untrusted-attribution → expand provenance coverage.
