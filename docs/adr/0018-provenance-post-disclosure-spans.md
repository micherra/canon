---
adr: "0018"
title: "Context provenance: spans computed post-disclosure, content_hash from pre-disclosure wording"
status: accepted
date: "2026-06-23"
build: "phase-1-step-0-trace-driven-evolution-provenance-instrumentation-emit-a"
---

# ADR-0018: Context provenance — spans post-disclosure, content_hash from pre-disclosure wording

## Context

Trace-Driven Evolution Phase 1 step-0 instruments `resolveAgentSkills` to emit a
`ContextProvenanceRecord` per agent spawn: each assembled artifact (rule/ref/primer/template) with a
sha256 `content_hash` of its exact in-context wording and a `char_span` into the final
`preload_prompt`. A future trace-led learner joins a `ReviewViolation` to the precise artifact wording
that was in context when an agent failed, and must be able to verify byte-identity (`content_hash`)
before mutating that artifact.

The complication: `resolveAgentSkills` runs `applyAgentSkillsDisclosure` as its last step. When
`preload_prompt` exceeds 12,000 chars, disclosure **blanks** every skill's `content` to `""`, writes
the full payload to a sidecar file (`.canon/artifacts/agent-skills-<hash>.json`), and replaces
`preload_prompt` with a slim summary plus a file pointer. So the text in the spawn prompt after
disclosure is NOT the text the resolver loaded.

Provenance correctness is load-bearing for safety: under trace-led targeting the attribution *chooses
the mutation target*, so a wrong hash or a stale span mis-targets a future mutation. This is not a
cosmetic logging concern — it is the safety property the entire Phase-1 program stands on.

## Options Considered

### Option A: Record during composition (pre-disclosure)

Compute both the hash and the span while assembling `preload_prompt`, before disclosure runs.

**Pros:**
- Single pass; spans are always non-null and trivially computed against the draft.

**Cons:**
- After disclosure fires, the recorded spans point into text that is NOT in the actual spawn prompt.
  A future consumer reading the span would read the wrong location (or a location absent from the
  prompt entirely). Empirically confirmed: disclosure removes the content from `preload_prompt`.

**Canon-principle alignment:** Violates provenance correctness (the build's load-bearing safety
property); the recorded location would not correspond to the spawn prompt.

### Option B: Record post-disclosure; span the final string; hash the original content

Append the `context_provenance` event AFTER `applyAgentSkillsDisclosure` returns. Compute each
`char_span` against the final (post-disclosure) `preload_prompt`. Compute each `content_hash` from the
content the resolver loaded BEFORE disclosure blanked it. Blanked artifacts get `char_span: null`,
`source: "sidecar"`, `sidecar_path: full_data_path`.

**Pros:**
- Spans target the text actually placed in the spawn prompt.
- `content_hash` identifies the real artifact wording even when blanked — so a future consumer can
  verify byte-identity against `path` + `content_hash` before mutating.
- Blanked artifacts are explicitly modeled as "present but deferred to a sidecar file," distinguishing
  inline text from sidecar-read text.

**Cons:**
- Two facts about the same artifact come from two stages: the hash from before disclosure, the span
  from after. This split is subtle and easy for a future contributor to get wrong (e.g. hashing the
  blanked `""`, which would make every disclosed artifact hash-identical and useless).

**Canon-principle alignment:** Honors provenance correctness; honors errors-are-values/fail-open (the
emit is wrapped and never blocks resolve).

## Decision

Chosen: **Option B — record post-disclosure, hash the pre-disclosure content.**

The span and the hash answer different questions and therefore come from different stages. The span
answers "where in the spawn prompt was this text?" — it must be computed against the post-disclosure
string and is `null` when the artifact was blanked out. The hash answers "what exact artifact wording
was in the agent's context?" — it must identify the real content even when blanked, so it is computed
from the content the resolver loaded before disclosure. Conflating them defeats attribution.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| errors-are-values | honors | Emit is fail-open (try/catch, `// Fail-open` comment), mirrors `logPitfallAuditEvent`. |
| deep-modules | honors | Hash/span/sidecar logic hidden behind a small pure builder; callers stay thin. |
| measure-before-optimizing / probe-before-build | honors | Disclosure-blanking behavior was empirically probed (invoked `applyAgentSkillsDisclosure`), not inferred. |
| line-limit-split-into-siblings | tension (resolved) | Touching `orchestration-journal.ts` (662 lines, pre-existing over-limit) required extracting the back-fill helper to a sibling. |

## Consequences

**Positive:**
- Recorded spans always correspond to the real spawn prompt; recorded hashes always identify real
  wording — the two invariants the future trace-led loop depends on.
- Blanked artifacts are first-class via `source: "sidecar"` + `sidecar_path`, so a future consumer
  knows the wording was a readable file, not inline text.

**Negative / trade-offs:**
- The emit path must capture skill content before disclosure and locate spans after — a two-stage flow
  that the unit tests must lock down (the high-coverage requirement targets exactly this).

## Revisit-If

- The spawn-prompt assembly stops passing through `applyAgentSkillsDisclosure`, or disclosure changes
  so that blanked content is no longer recoverable from `path` + `content_hash`.
- A future consumer requires the span to be non-null even for sidecar artifacts (would need a sidecar
  offset model, not a `preload_prompt` offset).
