# ADR-0026: Doc-corpus freshness is content-hash-keyed, not git-HEAD-keyed

- Status: Accepted
- Date: 2026-06-29
- Deciders: architect (semantic-index-the-knowledge-corpus build)

## Context

The structural knowledge graph stays fresh via `ensureGraphFresh`, which keys
staleness on `meta.graph_head_commit` versus the current git `HEAD` (O(1) marker
compare). The natural move for the new markdown-knowledge index would be to
piggyback the same trigger.

But the markdown corpora this build indexes are not git-HEAD-observable:

- **Build digests** live *outside the repo* at the Claude-Code memory dir
  (`$HOME/.claude/projects/<sanitized-projectDir>/memory/build-digest-*.md`).
  They are written continuously by builds and never appear in a project commit.
- **`.canon/principles/` and `.canon/proposed-learnings/`** are *gitignored*,
  project-local, and mutate (351 proposed-learnings today) without any commit.

A git-HEAD-keyed freshness gate would observe none of these change: the marker
would match HEAD while the corpus had materially changed, leaving the index
**silently stale** — the worst failure mode for a relevance store whose entire
value is "what have we learned recently?"

## Decision

The doc-corpus freshness gate (`ensureDocCorpusFresh`) keys staleness on a
**content hash of the resolved corpus source set** stored in `meta.doc_corpus_hash`,
not on git HEAD. The hash is computed over `(path, size, mtime)` of every `*.md`
file across the registered sources; on a mismatch the gate re-ingests (chunk →
embed → upsert) and re-stamps the marker. Structure otherwise mirrors
`ensureGraphFresh`: fail-open, per-DB single-flight, lazy on first read.

## Alternatives Considered

### A. Piggyback `ensureGraphFresh` (git-HEAD marker) — REJECTED
- Pros: zero new freshness code; O(1) marker compare per read.
- Cons: structurally cannot observe out-of-repo or gitignored corpus changes →
  silently stale index. Fails the core requirement.

### B. Content-hash corpus marker (CHOSEN)
- Pros: correct for out-of-repo + gitignored sources; reuses the
  `context-manifest.ts` content-hash precedent; same two-tier staleness model the
  KG already uses (corpus-level gate + per-chunk `text_hash`).
- Cons: each read pays a corpus stat-walk (path/size/mtime over the source set)
  instead of an O(1) commit compare. Mitigated by hashing cheap stat metadata
  (not file contents) at the gate; full content re-hash happens per-chunk only
  for chunks whose stat changed.

## Consequences

- A new `meta` key `doc_corpus_hash` is owned by the doc-corpus subsystem; it must
  never be conflated with `graph_head_commit`.
- First `search_knowledge` after a corpus change pays the ingest+embed cost
  (bounded by changed-chunk count); subsequent reads at the same corpus hash are a
  cheap stat-walk + compare.
- The two freshness subsystems are independent: a code-only commit does not
  trigger doc re-ingest, and a digest write does not trigger KG rebuild.

## Revisit If

- The corpus source set grows so large that the per-read stat-walk becomes a
  latency problem (then: cache the walk behind a short TTL, or move to an
  event/watch trigger).
- Canon gains a native out-of-repo change-notification mechanism that makes a
  marker compare viable for non-repo sources.
