---
id: ambient-advisory-dep-bump-pattern
title: Ambient-Advisory CI Failure Is Fixed by a Dedicated Dep-Bump to Main, Not Per-PR
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "mcp-server/package.json"
    - "**/package.json"
    - ".github/**"
    - "**/.github/**"
  tags:
    - security
    - ci
    - dependencies
---

An **ambient-advisory CI failure** — a high/critical advisory published in the upstream npm registry that is NOT caused by any PR diff and fails the `npm audit --omit=dev --audit-level=high` gate on every open PR simultaneously — must be resolved via a **dedicated dep-bump PR to main**, not per-PR workarounds. Per-PR fixes only defer the problem and create rebase churn across every blocked branch.

A separate sub-pattern applies when an advisory is NOT cleanly fixable: it must be DOCUMENTED with empirical evidence and an explicit accepted-risk rationale, never left silently.

## Resolution Pattern (fixable advisory)

1. Confirm the advisory fails on a fresh `main` checkout (not only open PRs). This confirms the ambient class and eliminates "fix in this PR" as an option — `main`'s last green build predated the advisory.
2. Identify the first patched version in-range for the vulnerable package; prefer a semver range over an exact pin.
3. Add the override to `mcp-server/package.json` under `overrides` (mirrors the `esbuild`/`protobufjs` precedent); regenerate `package-lock.json`.
4. Verify locally: `npm audit --omit=dev --audit-level=high` → exit 0.
5. Keep the override as narrow as possible — single package, one version range, not a wildcard.
6. File the dep-bump as a dedicated PR so all blocked PRs can rebase on the clean `main`.

## Unfixable-Advisory Pattern

If a fix requires an API-breaking version jump across an intermediate dependency that is pinned to the old API (e.g., `gray-matter@4.0.3 → js-yaml@3.x`, where `gray-matter` breaks under `js-yaml@4.x`), do NOT attempt an override that breaks the intermediate dependency. Instead:

1. Document the attempt and the empirical test failure (the override was applied; these tests broke).
2. State the residual-risk scope — critically, *does this dependency parse untrusted input?* (`gray-matter` parses trusted repo frontmatter, not attacker-controlled data.)
3. Record the conscious acceptance of the residual advisory with rationale, including that the advisory severity does not fail the gate (a MODERATE does not fail a high-only CI gate).

Never silently leave an unfixable advisory without a durable record of the decision.

## Rationale

An ambient advisory is registry state, not PR state: every open PR's audit gate flips red at the same instant, independent of what each branch changed. Fixing it per-PR means N branches each carry an identical override that must be reconciled at merge; the dedicated-bump-to-main approach fixes it once and lets every blocked branch rebase onto green. The override mechanism (npm `overrides`) is the right lever because the vulnerable package is usually transitive (pulled via `tsx → esbuild`, `@huggingface/transformers → onnxruntime → protobufjs`) and cannot be bumped by editing a direct dependency.

The unfixable sub-pattern exists because silently leaving an advisory is indistinguishable from missing it. An explicit, evidence-backed accepted-risk record converts a silent gap into an auditable decision, and the trusted-input scoping is what justifies accepting it.

## Examples

**Good — transitive high-sev advisory pinned via a narrow override in a dedicated PR (PR #403):**

```jsonc
// mcp-server/package.json — dedicated dep-bump PR to main.
// protobufjs GHSA-f38q-mgvj-vph7 pulled via @huggingface/transformers → onnxruntime.
// Verified: npm audit --omit=dev --audit-level=high → exit 0.
"overrides": {
  "protobufjs": "^7.6.4"
}
```

**Bad — patching the advisory inside an unrelated feature PR:**

```text
A feature PR adds the protobufjs override alongside its feature diff.
Result: the other 3 blocked PRs stay red; each must add the same override;
all four overrides must be reconciled at merge. The fix was not shared.
```

**Good — unfixable moderate advisory documented with empirical evidence (PR #403):**

```text
js-yaml GHSA-h67p-54hq-rp68 (<=4.1.1 quadratic DoS) via gray-matter@4.0.3 → js-yaml@3.x.
Attempted: override js-yaml ^4.1.0 → gray-matter tests fail (3.x API removed).
Residual scope: gray-matter parses trusted repo frontmatter, not untrusted input.
Severity: MODERATE — does not fail the high-only CI gate.
Decision: accept the residual risk; recorded with the test-failure evidence above.
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I'll just add the override in my current PR to unblock myself." | The other blocked PRs stay red and each ends up carrying a duplicate override that conflicts at merge. | File a dedicated dep-bump PR to main so every blocked branch rebases onto green. |
| "The advisory is unfixable, so I'll just leave it." | A silent unfixable advisory is indistinguishable from a missed one. | Document the attempt, empirical failure, residual-risk scope, and explicit acceptance. |
| "A wildcard override is simpler." | Wildcards over-broaden the version surface and can mask future regressions in unrelated packages. | Pin the single vulnerable package to one narrow semver range. |

## Reviewer Check

When a PR adds an `overrides` entry to clear an audit advisory: confirm (1) the advisory is ambient (fails on fresh `main`, not introduced by this diff) and the PR is a dedicated dep-bump rather than a feature PR carrying an unrelated override; (2) the override is narrow (single package, one range); (3) `npm audit --omit=dev --audit-level=high` exits 0 locally. When an advisory is left unaddressed: confirm a durable record states the empirical failure, the trusted-vs-untrusted input scope, and the explicit risk acceptance.

**See also:** `hooks-fail-closed`, `fail-closed-by-default` — the broader fail-closed posture; `minimize-attack-surface` — the dependency-surface principle this operationalizes for the supply-chain audit gate.

## Verification

- [ ] An ambient high/critical advisory is resolved by a dedicated dep-bump PR to main (narrow `overrides` entry), confirmed to fail on a fresh `main` checkout first.
- [ ] `npm audit --omit=dev --audit-level=high` exits 0 after the bump.
- [ ] Any unfixable advisory left in place carries a durable record of the empirical failure, the trusted-input scope, and the explicit accepted-risk rationale.
