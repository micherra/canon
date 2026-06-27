---
id: adr-sequential-id-contention
title: ADR Sequential-ID Contention Must Be Caught by a Pre-Push Gate, Not Manual Re-Verify
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "docs/adr/**"
    - "hooks/adr-number-check.sh"
  tags:
    - adr
    - hooks
    - process
---

Concurrent Canon build branches each assign the next sequential `docs/adr/NNNN` number by scanning their base commit (`next = highest-on-disk + 1`). Because `origin/main` advances during the build window, two concurrent builds — or one build whose chosen number is claimed by a PR that merges before it ships — independently pick the **same** number. They collide as a benign additive-file conflict at merge time, and `docs/adr/README.md` conflicts. This struck PR #415 as instance #16, requiring a manual ADR-0022→0023 renumber. Long multi-pass builds (security builds with several verify cycles, for example) are highest-risk because `origin/main` advances more during the extended window.

The manual "re-verify the number before ship" mitigation in `docs/adr/README.md` has been behaviorally **unadopted** across 16 consecutive occurrences. A documentation reminder is insufficient. The durable fix is a **deterministic gate**.

## The Protocol

1. **Numbering**: ADR filenames follow the form `NNNN-slug.md` — 4-digit zero-padded sequential integer, assigned at design time by scanning the highest existing number on disk and incrementing. This is correct and necessary but **insufficient** on its own, because the scan is stale as soon as another PR merges to `origin/main`.

2. **Index row**: Every ADR gets a matching row in `docs/adr/README.md`, kept in ascending numeric order. Both the file and the row must be renumbered atomically when a collision is resolved.

## The Mandate

A deterministic pre-push gate **MUST** fail closed when a branch's newly-added `docs/adr/NNNN-*.md` number already exists on `origin/main`:

```bash
# hooks/adr-number-check.sh
# Invoked by the pre-push hook.
# Exit 2 (BLOCK) when any new docs/adr/NNNN-*.md on this branch has an NNNN
# that already exists on origin/main.
# Exit 0 (ALLOW) when no collision is detected.
# A network fetch failure → fail OPEN with a warning (network dependency; a missed
# collision here is benign because the local origin/main check already covers it).
```

Gate posture:

- **Local `origin/main` check — fail CLOSED**: the locally-cached `origin/main` refs are sufficient for the collision check. A number that already exists there is a definite collision — block hard (exit 2) and name the colliding number in the error message.
- **Network-dependent open-PR check (optional) — fail OPEN**: checking whether any open GitHub PR has claimed the same number is advisory only. A network failure or API timeout must NOT block the push — emit a warning and continue (exit 0).

## Resolution When the Gate Fires

1. **Identify the free number**: `git fetch origin` then scan `origin/main:docs/adr/` for the highest existing number; `next = highest + 1`.
2. **Rename the file**: `git mv docs/adr/NNNN-slug.md docs/adr/MMMM-slug.md`.
3. **Update the heading and frontmatter**: in the renamed file, update the `# MMMM: Title` heading and any `id:` or `number:` frontmatter fields that embed the old number.
4. **Update `docs/adr/README.md`**: replace the old NNNN row with the MMMM row; keep rows in ascending numeric order.
5. **Update in-tree cross-references**: grep the full repo for the old number string (e.g., `ADR-NNNN`, `NNNN-`, `adr/NNNN`) and update each reference.

## Why Manual Re-Verify Fails

The "re-verify before ship" instruction has been in `docs/adr/README.md` throughout 16 occurrences. The failure is structural, not a gap in individual attention:

- The check requires the author to remember it at ship time, after the full build-review cycle.
- Under a supervised tier with several HITL gates, ship time may be hours or days after the number was assigned.
- Nothing in the build pipeline enforces it — it is a behavioral commitment made under deadline.

Behavioral mitigations for repeated sequential failures are a well-known Canon pattern: each documentation reminder closes one incident and opens the next. The correct response is to mechanize the check (see `[[security-hook-parser-allowlist-posture]]` — the same mechanical-gate-beats-manual-vigilance lesson applies here as to security-hook denylists).

## Future Option (Out of Scope Here)

A non-sequential ID scheme — timestamp-prefixed (`20260625-slug.md`), UUID-based, or branch-prefix-based — would eliminate the contention class structurally because each branch generates a globally-unique name without coordination. This touches every ADR consumer (cross-references, links, README rows, tooling) and is not mandated here. It is recorded as the structural endgame if the collision rate warrants the migration cost.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "I'll just re-verify the number before I push." | 16 instances show this commitment is not sustained under build pressure. The check requires memory at exactly the wrong moment. | Implement `hooks/adr-number-check.sh` and let the gate catch it. |
| "Renaming takes extra work; I'll keep the old number since the collision is just a conflict." | Two identically-numbered ADRs in the index permanently confuse the sequential record. `docs/adr/README.md` cannot hold two rows for the same number sensibly. | Always renumber the later ADR. The gate fires before push — do it then. |
| "The open-PR check fails sometimes; I'll make it fail closed to be safe." | Network-dependent checks that fail closed become build-breaking flaky gates on CI. The collision is already caught by the local `origin/main` check, which is always available. | Keep the network-dependent check fail-open with a warning. |

## Reviewer Check

When reviewing a PR that adds a new `docs/adr/NNNN-*.md`:

1. Confirm `hooks/adr-number-check.sh` exists and is wired into the pre-push hook.
2. Confirm the new ADR's number does not already appear in `docs/adr/README.md` on `origin/main`.
3. Confirm `docs/adr/README.md` has a matching row for the new ADR, in ascending numeric order.

## Related

- [[hooks-fail-closed]] — the gate must exit non-zero on a confirmed collision; this convention applies the fail-closed principle to the ADR numbering check.
- [[fail-closed-by-default]] — general fail-closed principle; the local `origin/main` tier of `adr-number-check.sh` is the fail-closed surface.
- [[security-hook-parser-allowlist-posture]] — the same mechanical-gate-beats-manual-vigilance lesson: behavioral mitigations for a structural failure require mechanization, not more documentation.

## Verification

- [ ] `hooks/adr-number-check.sh` exists and is invoked from the pre-push hook.
- [ ] Any new `docs/adr/NNNN-*.md` added in a branch does not collide with a number already on `origin/main` before the PR merges.
- [ ] `docs/adr/README.md` is updated with a matching row in ascending numeric order for every new ADR.
- [ ] When the gate fires, the renumbering updates the file name, heading, frontmatter, README row, and all in-tree cross-references.
