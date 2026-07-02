---
adr: "0033"
title: "Success-pattern learner mines the auto-memory digest corpus"
status: accepted
date: "2026-07-01"
build: "m1-success-pattern-learner (AgentKB R4) — design"
---

# ADR-0033: Success-pattern learner mines the auto-memory digest corpus

## Context

M1 (AgentKB R4) gives Canon's learner its first positive-signal source: a `success-pattern`
sub-analysis that mines *clean* builds for recurring elegant resolutions and proposes them as
conventions. It needs one qualitative line per clean build (`notableResolution`) and a place for
the learner to read it. Exploration `docs/explore/positive-signal-distillation.md` §3 scopes M1 as
"a tiny producer change" — no new MCP tool, no new attribution primitive. Two transports are viable;
the choice determines how much surface M1 touches and whether the learner reads outside `.canon/`.

This decision is hard-to-reverse (once digests carry the field and the learner depends on the digest
corpus as its input, changing the transport means re-cutting both the producer and the consumer's read
path), surprising-without-context (a reader would not expect the learner to read the Claude Code
auto-memory directory rather than an in-repo/MCP source), and a genuine trade-off (Option A trades
transport cleanliness for scope; Option B the reverse) — so it passes the 3-condition ADR gate.

## Options Considered

### Option A: Emit `notableResolution` into the auto-memory build-digest files; learner reads that corpus directly

**Pros:**
- Single producer change (`digest-writer.ts` + one pure extractor in `run-summary-extractors.ts`).
- The clean-build corpus (measured 156/232 clean) already lives in exactly this location.
- The learner already has Read/Glob/Bash and reads other outside-`.canon` context (build history).

**Cons:**
- The learner reads outside the repo/`.canon/` (the auto-memory dir) and must resolve the dashed
  project-path (mirroring `resolveAutoMemoryDir`).

**Canon-principle alignment:** honors `simplicity-first` — smallest change matching M1's stated scope.

### Option B: Thread `notableResolution` through `RunSummary` → `get_historical_artifacts` / `get_cross_run_analysis`; learner reads via MCP

**Pros:**
- In-repo, MCP-native transport; no outside-repo read path.

**Cons:**
- Expands the change into `run-summary-builder.ts` + `archive-types.ts` + the cross-run analyzer plus
  their tests — contradicting M1's "tiny producer change" scope.

**Canon-principle alignment:** tensions `simplicity-first` for marginal transport cleanliness.

## Decision

Chosen: **Option A — mine the auto-memory digest corpus.**

It keeps M1 the small producer change the exploration specified. The learner resolves the memory dir
deterministically from `project_dir` (dashed-path transform, mirroring `resolveAutoMemoryDir` in
`mcp-server/src/features/orchestration/services/digest-writer.ts`) and globs `build-digest-*.md`. The
producer↔consumer coupling reduces to one frozen string contract: the digest line
`**Notable resolution**: {text}` in a `### Notable Resolution` section (section omitted when empty).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | One producer field + one pure extractor; no new tool, no new primitive. |
| observable-best-effort | honors | Producer field is best-effort; missing SUMMARY/DESIGN → empty field, section omitted, never a digest-write failure. |
| measure-before-optimizing | honors | Downstream promotion still requires counted, weighted recurrence (≥3 distinct clean builds). |

## Consequences

**Positive:**
- M1 stays a ~2-file producer change plus a prose sub-analysis; fast to build and review.
- No coupling to the archive/cross-run surface; the digest corpus is a stable, append-only input.

**Negative / trade-offs:**
- The learner gains a read dependency on the auto-memory directory layout and the dashed-path
  resolution — a coupling that must survive environment differences.
- A second consumer wanting `notableResolution` via MCP would need Option B added later (additive,
  not blocked).

## Revisit-If

- The learner's read of the auto-memory corpus proves unreliable across environments (dashed-path
  resolution fails on some platform), OR
- Another consumer needs `notableResolution` through MCP — at which point promote to Option B
  (thread the field through `RunSummary`) as an additive change.
