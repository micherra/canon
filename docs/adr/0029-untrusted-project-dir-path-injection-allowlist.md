# ADR-0029: Untrusted project-dir path-injection guard uses an allow-list, not containment

- Status: accepted
- Date: 2026-06-29
- Deciders: architect (build: address-all-11-open-github-code-scanning-alerts)

## Context

`session-manager.ts` resolves a per-session project scope from client-supplied input on the HTTP
daemon's untrusted-input boundary: the `x-canon-project-dir` request header and, as a fallback, the
URI returned by the client's MCP `roots/list`. Both flow into `validateAndNormalizeDir(dir)`, which
calls `existsSync(dir)`, `statSync(dir)`, and `realpath(dir)`. CodeQL `js/path-injection` (high)
flagged all three fs calls (alerts 10, 11, 12): the path used for filesystem access is constructed
from user-controlled data, and the raw value reaches the fs calls without a validation barrier.

The resolved scope is consequential — it keys per-project state isolation (execution store, drift DB,
job manager) and is the base for `.canon/` reads/writes. A malicious local process holding the daemon
token could otherwise point the daemon at an arbitrary directory.

CodeQL's own remediation guidance offers three strategies: (1) **containment** — normalize then check
the path starts with a fixed safe root; (2) **allow-list of safe patterns** on the input; (3)
filename sanitization (for single-component names only). The code already normalized via `realpath`,
but had no barrier and no containment check.

## Options Considered

### Option A: Containment within a fixed safe root
Normalize the input and require it to start with a known base directory.
- **Pros**: CodeQL's primary, most-recognized strategy; strongest guarantee when a root exists.
- **Cons**: **There is no fixed safe root.** A Canon project legitimately lives at *any* absolute path
  on the user's machine (`/Users/x/proj`, `/srv/work/y`, `/private/tmp/...`). Inventing an artificial
  root would either reject legitimate projects or be a no-op wrapper that adds nothing.
- **Canon alignment**: would violate simplicity-first (fake root) for no real gain.

### Option B: Allow-list of safe patterns on the raw input (CHOSEN)
A pure validator `isSafeProjectDirInput(dir)` rejects, before any fs access: empty/over-length input,
NUL and control characters, non-absolute paths, and any path bearing a `..` segment after
normalization. The existing `realpath` canonicalization is kept (resolves symlinks).
- **Pros**: Fits the domain (no fixed root needed); genuinely constrains the boundary (relative,
  traversal, and injection inputs are rejected fail-closed); single chokepoint — both untrusted entry
  paths already funnel through `validateAndNormalizeDir`, so there is no second-writer bypass (the
  failure mode ADR-0026 §amendment identified). Pure leaf helper in `shared/lib/`, unit-testable.
- **Cons**: CodeQL calls allow-listing "the most restrictive" option; it is a weaker formal guarantee
  than containment, and we cannot prove pre-merge that CodeQL clears the alert (the `codeql` CLI is
  not installed locally — verification is the post-merge scan).
- **Canon alignment**: fail-closed-by-default, simplicity-first, deep-modules (shared leaf).

### Option C: Cast / scanner-appeasement
Annotate or cast to silence CodeQL without changing behavior.
- **Pros**: trivial.
- **Cons**: Explicitly forbidden by the PRD non-negotiable ("hold the real trust boundary, not merely
  silence the scanner"); leaves the actual exposure open.

## Chosen: Option B

## Rationale

Project directories have no enclosing root, which structurally rules out CodeQL's containment
strategy. The allow-list barrier is the applicable documented strategy and genuinely narrows the
boundary: an untrusted header can no longer steer the daemon with a relative path, a `..` traversal,
or a NUL/control-char injection. Normalization (`realpath`) is retained so the registered scope is
always canonical. Centralizing the check in one pure helper at the single chokepoint avoids the
second-writer divergence that bit the overlay trust boundary (ADR-0026).

## Consequences

- New module `mcp-server/src/shared/lib/safe-project-dir.ts` exporting `isSafeProjectDirInput`;
  imported by `session-manager.ts` only.
- `validateAndNormalizeDir` applies the barrier before `existsSync`/`statSync`/`realpath` and resolves
  before stat. Behavior is unchanged for legitimate absolute project dirs; malformed inputs now return
  `undefined` (scope stays pending — existing fail-closed path).
- "Scanner no longer flags" is verified by the **post-merge** CodeQL scan, not pre-merge (no local
  `codeql`). The new workstream-2 routine (`code-scanning-autofix`) is the standing mechanism that
  catches a regression here.

## Revisit If

- A fixed safe root for project dirs is ever introduced (then prefer containment, Option A).
- CodeQL continues to flag the sites after merge (then the barrier needs a form CodeQL recognizes as a
  sanitizer — e.g. a single regexp `.test()` guard on the raw input).
- A second code path begins constructing fs paths from untrusted input without funneling through
  `validateAndNormalizeDir` (re-evaluate the chokepoint assumption).
