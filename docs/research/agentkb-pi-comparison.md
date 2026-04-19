# agentkb + pi.dev vs Canon

**Sources:**
- https://github.com/isaac-flath/agentkb (raw README: https://raw.githubusercontent.com/isaac-flath/agentkb/main/README.md) — **source unreachable** (HTTP 404 on raw README)
- https://pi.dev — **source unreachable** (HTTP 403 on landing page)
**Date:** 2026-04-19
**Status:** Both primary sources were unreachable within the time budget. Per task instructions, no retries and no fallback searches were attempted. This report records the unreachability and frames what a follow-up pass would need to produce.

---

## isaac-flath/agentkb

Source unreachable. Based solely on the repository name ("agentkb" = agent knowledge base) from an author known for fast-ai-adjacent tooling, the project is plausibly a lightweight convention for giving coding agents a durable, file-backed knowledge base that accumulates across sessions. Without the README, a responsible comparison cannot be made — the table below lists the concept slot but classifies every idea as unknown pending a successful fetch.

| Idea | Classification | Canon equivalent or gap |
|------|----------------|-------------------------|
| (README contents) | **Unknown — source unreachable** | n/a — rerun fetch required before classification |
| Agent-visible knowledge base (inferred from name only) | **Unverified** | Canon has principles (`principles/`), the knowledge graph (`mcp-server/src/features/knowledge-graph/`), drift reports, and workspace `progress.md` — all of which are durable, agent-readable knowledge. Overlap is likely but cannot be confirmed. |

---

## pi.dev

Source unreachable (HTTP 403 — likely bot/CDN challenge on the landing page, not a content issue). No description can be given without seeing the page; the product could be an evals/monitoring platform, an agent infra play, or something unrelated. The comparison table is therefore empty pending a successful fetch.

| Idea | Classification | Canon equivalent or gap |
|------|----------------|-------------------------|
| (Landing page contents) | **Unknown — source unreachable** | n/a — rerun fetch required before classification |

---

## Worth adopting (2-4 items)

- **None identified.** With both primary sources unreachable, no adoption recommendations can be made in good faith. Speculating from product names alone would produce advice uncorrelated with the actual projects.
- **Action item:** Rerun the fetch with a browser-style User-Agent (for pi.dev's 403) and verify the correct default branch / README path for agentkb (the 404 suggests `main/README.md` is wrong — the repo may use `master`, or the README may be named differently).

---

## Non-fits

- **None identifiable.** Non-fit classification requires knowing what the project actually proposes. Deferred until sources are reachable.

---

## Follow-up Fetch Plan

When rerunning this research:

1. **agentkb** — try `https://github.com/isaac-flath/agentkb` (HTML landing) first to confirm default branch and README filename. The 404 on `raw.githubusercontent.com/.../main/README.md` indicates either the branch is `master` or the README has a different path. Use `gh api repos/isaac-flath/agentkb` to resolve default branch deterministically.
2. **pi.dev** — the 403 suggests CloudFront or similar bot protection. Try `https://www.pi.dev`, `https://pi.dev/about`, or a documented product URL. If still blocked, consult cached sources (archive.org) or the company's GitHub org if one exists.
3. Once both are reachable, classify ideas against Canon using the same five-bucket schema used in `codeflow-comparison.md`: Duplicate, Partial overlap, Novel, Non-fit, Already-deferred.

---

## Summary of the Fit Assessment

Unable to assess. Both sources were unreachable on first fetch and the task's no-retry / no-search constraint prevents recovery within this pass. This document exists as a placeholder so the failed attempt is visible in `docs/research/` and the follow-up fetch plan is preserved for the next attempt. Do not draw conclusions from this report's empty tables — they reflect fetch failure, not an absence of interesting ideas in either project.
