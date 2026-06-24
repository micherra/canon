---
id: ambient-advisory-dep-bump-pattern
title: Ambient npm Advisory Requires a Dedicated Dep-Bump PR to Main
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "**/package.json"
    - "**/package-lock.json"
    - "**/.github/workflows/**"
    - "**/mcp-server/package.json"
tags: []
---

An ambient-advisory CI failure — a high or critical severity advisory published in the upstream npm registry that is not caused by any PR diff — must be resolved via a **dedicated dep-bump PR to main**, not per-PR workarounds. Per-PR workarounds defer the problem and create rebase churn on every other open PR simultaneously.

## Rationale

When a new high-severity advisory is published against a package already in the dependency tree, the CI gate (`npm audit --omit=dev --audit-level=high`) fails on every open PR at once. The advisory is ambient: it predates the PR diff and exists on `main`. A fix landed inside an unrelated PR is harder to review, creates unnecessary merge pressure, and will need to be rebased by all sibling PRs anyway. A dedicated dep-bump PR to main isolates the supply-chain fix, gives it a clean commit history, and unblocks all other PRs via a single rebase.

Evidence: PR #368 (fast-uri path traversal, high severity) was the first observed instance of the ambient-advisory class — it was cleared bundled inside a broader prod-readiness PR alongside unrelated changes, which is the anti-pattern this convention steers away from. PRs #397 (esbuild GHSA-gv7w-rqvm-qjhr) and #403 (protobufjs GHSA-f38q-mgvj-vph7 / GHSA-wcpc-wj8m-hjx6) established the recommended pattern: each was a dedicated dep-bump PR to main that unblocked all concurrently affected open PRs via a single rebase.

## Resolution Pattern

1. Confirm the advisory fails on a fresh `main` checkout (not only on open PRs) — this confirms the ambient class and eliminates "fix in this PR" as an option.
2. Identify the first patched version in-range for the vulnerable package; prefer a semver range over an exact pin.
3. If the direct dependency cannot be updated (e.g., a transitive dep through a pinned intermediary), add an `overrides` entry to the root `package.json` (or `mcp-server/package.json` as appropriate). Keep the override as narrow as possible — single package, one version range, no wildcards.
4. Regenerate `package-lock.json` (`npm install`).
5. Verify locally: `npm audit --omit=dev --audit-level=high` must exit 0.
6. File the fix as a dedicated PR so all blocked open PRs can rebase on the clean `main`.

## Unfixable Advisory Pattern

Some advisories cannot be cleanly fixed because the fix requires an API-breaking version jump across an intermediate dependency that is pinned to the old API (e.g., `gray-matter@4.0.3` is pinned to `js-yaml@3.x` and breaks under `js-yaml@4.x`). In these cases:

- **Do not** apply an override that breaks the intermediate dependency.
- **Document the attempt** and the empirical test failure that resulted.
- **State the residual risk scope** — specifically whether the affected dep processes untrusted input.
- **Record a conscious acceptance** of the advisory with rationale (e.g., "gray-matter parses trusted repo frontmatter; MODERATE severity does not fail the high-only CI gate").
- Never silently leave an unfixable advisory without a documented decision.

## Examples

**Bad — fixing the advisory inside an unrelated PR:**

```diff
# Inside PR #123 (adding a new feature unrelated to deps)
+  "overrides": {
+    "esbuild": "^0.28.1"
+  }
```

This hides a supply-chain fix inside a feature PR, complicating review, and every other open PR still fails the CI gate until they rebase onto this PR.

**Good — dedicated dep-bump PR to main:**

```json
// mcp-server/package.json — standalone dep-bump PR #403
"overrides": {
  "protobufjs": "^7.6.4"
}
```

PR title: `fix(deps): override protobufjs to 7.6.4 — clear high-sev npm-audit advisory blocking CI`

The fix lands on `main` first; all open PRs rebase on the clean `main`.

**Unfixable advisory — documented acceptance:**

```markdown
<!-- In the PR description or commit message -->
gray-matter@4.0.3 depends on js-yaml@3.14.2 (GHSA-h67p-54hq-rp68, quadratic-DoS, MODERATE).
Attempted override to js-yaml@4.x: gray-matter breaks (API incompatible, test failures confirmed).
Residual risk: gray-matter parses trusted repo-internal frontmatter only, not untrusted user input.
Decision: accept MODERATE advisory; excluded from high-only CI gate. No silent omission.
```

## Exceptions

If an open PR is itself a dependency update that intentionally changes the affected package (e.g., a planned major-version upgrade), the advisory fix may be included in that PR rather than a separate dep-bump. Document the rationale in the PR description.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I'll just add the override in my current PR." | Sibling PRs still fail CI until they rebase on your PR, and the fix is buried in an unrelated diff. | File a dedicated dep-bump PR to main first; rebase everything onto it. |
| "The advisory is only MODERATE, I'll skip the override." | Leaving a moderate advisory without at least a documented decision normalizes silent risk acceptance. | Assess the residual risk and record the decision; do not silently ignore. |
| "An exact pin is safer than a range." | Exact pins freeze you at the first patched version; a range allows patch-level fixes going forward. | Prefer `"^x.y.z"` (semver range) unless a range is explicitly problematic. |

## Verification

- [ ] A fresh `main` checkout confirms the advisory fails before the fix is applied (ambient class confirmed).
- [ ] `npm audit --omit=dev --audit-level=high` exits 0 after applying the override locally.
- [ ] The override is the narrowest possible (single package, one semver range).
- [ ] If the advisory is unfixable, the PR or commit documents the attempt, test-failure evidence, residual risk scope, and rationale for acceptance.
