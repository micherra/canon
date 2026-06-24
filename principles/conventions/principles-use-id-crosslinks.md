---
id: principles-use-id-crosslinks
title: Principles Cross-Link Related Principles by ID
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "principles/**/*.md"
    - ".canon/principles/**/*.md"
tags:
  - meta
  - documentation
---

When a principle has a genuine relationship to another principle — refinement, companion, tension, or shared mechanism — express it as a `[[principle-id]]` wiki-link in a `## Related` prose section near the end of the body. Each link must carry a one-clause rationale explaining the relationship. Links must sit in real prose, never inside code fences or backticks.

## Rationale

`wiki_lint orphan_principles` measures whether each principle in the corpus is the *inbound target* of at least one `[[id]]` link. Without a corpus-wide linking convention, even genuine relationships expressed as `` `id` `` in backticks are invisible to the text-node extractor (PROBE-FINDINGS-R3 P3), and principles that nobody points at remain orphaned even if their authors intended them to be related. An empirical probe confirmed that direction matters: a `## Related` link in principle A de-orphans **A's target B**, not A (PROBE-FINDINGS-R3 P5). When no convention enforces outbound links, each new principle becomes a new orphan by default, and the orphan check accumulates noise until it stops being a true signal.

By convention, every principle that has genuine relationships cites them with `[[id]]` syntax, keeping the orphan floor at the documented `.canon/principles` residual (26 Canon-internal, gitignored principles) rather than growing unboundedly with each new principle added.

## Examples

**Good — a `## Related` section with prose links and one-clause rationale:**

```
## Related

[[managed-artifact-class-shape]] is a companion meta-convention — both govern how Canon's own artifact corpus is authored: one constrains shape, the other constrains cross-linking.
```

**Bad — the same relationship expressed in backticks inside body prose:**

The related principle is `managed-artifact-class-shape`, which covers artifact shape.

This looks like a link but the text-node extractor excludes code spans, so it produces no inbound credit for the target.

**Bad — a bare "see also" with no relationship clause:**

```
## Related

See also: [[managed-artifact-class-shape]]
```

A link with no rationale clause does not convey the nature of the relationship. The convention requires a one-clause explanation so authors and reviewers can verify genuineness.

## Exceptions

- **`.canon/principles` residual**: The 26 gitignored, portable:false Canon-internal principles are an accepted residual. They are not shippable in a PR, so they cannot be inbound targets from tracked principles. Their orphan status is documented, not chased.
- **Non-resolving ids**: If a principle id exists in prose but does not resolve to a real principle file (tracked or `.canon`) — e.g., `component-single-responsibility` — keep it as `` `backtick` `` prose rather than converting it to `[[id]]`. Unresolvable links introduce a `BROKEN_WIKILINK` finding and would fail the `link_integrity` gate.

## Related

[[managed-artifact-class-shape]] is a companion meta-convention — both govern how Canon's own artifact corpus is authored: one constrains the five-element shape of a new artifact class, the other constrains how principles within that corpus cross-link. [[leave-touched-files-better]] is the principle this convention mechanically enforces when touching a principle file — converting inert backtick references to live `[[id]]` links is the canonical application of "leave it better."
