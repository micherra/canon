---
adr: "0023"
title: "Overlay injection scanner is fail-closed structural, not a token blocklist"
status: accepted
date: "2026-06-25"
build: "phase-0-context-hardening-posthogcontext-mill-explore-4-overlay"
---

# ADR-0023: Overlay injection scanner is fail-closed structural, not a token blocklist

## Context

`.canon/` overlays — user corrections (`.canon/corrections/*.json`), project-local
principles (`.canon/principles/**`), principle overrides, and routine definitions — are
loaded fail-open and rendered into agent spawn prompts (see this build's PROBE-FINDINGS
Probe 1). They are untrusted operator input on a prompt-injection path. Phase-0 adds a
reusable scanner gating them. The design question is the scanner's *posture*: Canon's
`security-hook-parser-allowlist-posture` convention (watch_UUUUUUUU2 lineage) records that
enumerated bad-token lists are a losing game — each listed token closes one bypass form and
opens the next unlisted one.

## Options Considered

### Option A: Enumerated injection-token blocklist

**Pros:**
- Simple to write; matches are obvious and easy to unit-test.

**Cons:**
- Every new obfuscation (encoding, spacing, synonym, wrapper) evades it.
- It is precisely the enumeration anti-pattern the allowlist-posture convention forbids.

**Canon-principle alignment:** violates `security-hook-parser-allowlist-posture`; weakens
`fail-closed-by-default` (unrecognized input passes).

### Option B: Fail-closed structural gate (bounds + normalizability) + secondary signature layer

**Pros:**
- Default-deny on un-normalizable or over-threshold input — vocabulary-free.
- Obfuscation that hides directives cannot survive the normalizability gate.
- The injection-signature detection is a secondary high-signal layer, never the sole gate.
- One reusable export; Phase-1 transcript-additions consume it unchanged.

**Cons:**
- False positives: benign content that legitimately quotes `system:` or uses unusual
  characters may be excluded. Mitigated by logging every exclusion (observable, not silent).

**Canon-principle alignment:** honors `security-hook-parser-allowlist-posture`,
`fail-closed-by-default`, `validate-at-trust-boundaries`.

## Decision

Chosen: **Option B — fail-closed structural gate with a secondary signature layer.**

`scanOverlayContent(text, opts)` evaluates in order: (1) byte-bounds gate, (2)
normalizability gate (reject disallowed control/bidi/zero-width/surrogate/NUL — the
load-bearing default-deny), (3) injection-signature detection over the normalized text as
risk signal. The primary deny lives in steps 1–2, so unrecognized input fails closed
without any enumerated vocabulary.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| security-hook-parser-allowlist-posture | honors | gate is structural/vocabulary-free; no enumerated wrapper list to extend |
| fail-closed-by-default | honors | un-normalizable / over-threshold → DENY; load site excludes |
| validate-at-trust-boundaries | honors | scanner is the validation at the `.canon/` overlay boundary |
| deep-modules | honors | one small-interface exported function hides the layered gate |

## Consequences

**Positive:**
- A reusable, posture-correct security boundary that Phase-1 reuses without modification.
- Overlay exclusions are logged — the boundary is observable.

**Negative / trade-offs:**
- Benign-but-unusual overlay content can be excluded (false positives); accepted because the
  trust boundary must fail toward exclusion, and exclusions are logged.
- kg-languages/grammars config overlays are out of this scanner's scope — they receive a
  separate fail-closed structural assertion (different risk shape; see build decision phase0-03).

## Revisit-If

- The false-positive rate on real overlays becomes operationally painful → tune the
  normalizability allowance; never relax the gate into an enumerated blocklist.
- A grammar-binary supply-chain threat is raised → add `.wasm` integrity verification as its
  own workstream (explicitly deferred here).
