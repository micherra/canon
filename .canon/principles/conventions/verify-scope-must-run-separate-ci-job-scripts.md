---
id: verify-scope-must-run-separate-ci-job-scripts
title: When Touching Separate-CI-Job Scripts, Explicitly Run Them in Verify
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "scripts/**"
    - "mcp-server/**/*.test.sh"
    - "mcp-server/**/*.e2e.test.sh"
tags:
  - verify
  - ci
  - process-health
---

When a build modifies shell or Node scripts that run as their own independent CI jobs — scripts that are NOT part of `npm test`'s vitest suite, NOT in `hooks/**` (which is covered by `[[shell-test-gate]]`), and NOT exercised by `bash hooks/lint.sh` (shellcheck syntax only) — the verify step MUST explicitly execute those scripts before committing. Standard verify (`npm run build → npm run lint → npm test → bash hooks/lint.sh → bash hooks/dead-wire-gate.sh → bash hooks/shell-test-gate.sh`) does not invoke them. The engineer must add the invocation manually.

**Discriminator:** the script runs as its own CI job (a separate YAML workflow step or job), but the local verify pipeline does not invoke it. When that script changes, CI is the first place the break surfaces — the verify step passes locally because it never ran the changed script.

**Out of scope — `hooks/**/*.test.sh` suites:** That class is already closed deterministically by `hooks/shell-test-gate.sh`, which runs the full `hooks/**/*.test.sh` set whenever any hook `.sh`/`.mjs` file changes (see the shell-CI-parity gate entry in the CLAUDE.md Step Enforcement Contracts). This convention targets the residual separate-CI-job class the gate intentionally cannot automate.

## Rationale

Canon's verify step is scoped to the TypeScript + hook surface. It exercises TypeScript compilation, biome lint, vitest unit tests, and shellcheck syntax over `hooks/`. It does NOT exercise shell or Node scripts that run as standalone CI jobs in `.github/workflows/`. When those scripts are changed, shellcheck may pass (correct syntax), `npm test` may pass (no vitest coverage), and the local review may be CLEAN — while the corresponding CI jobs are red.

The structural gap: a script that runs as its own CI job has environment-conditional behavior or daemon dependencies that make a fail-closed local gate impractical without replicating CI's full matrix. For example:
- `scripts/install-sim-smoke.mjs` exits 1 (intentionally) when the local Node version equals the pinned version in the guard — an EXPECTED guard exit, not a failure. Running it fail-closed locally would false-fail on any developer whose Node matches the pin.
- `mcp-server/boot.e2e.test.sh` boots a live MCP daemon — impractical to run reliably in a pre-verify shell step without CI's clean environment.

Because a deterministic gate cannot close this class safely, the obligation falls on the engineer: when you change one of these scripts, you own verifying it runs correctly before the review step.

**Evidence:**

| Build | Changed scripts | CI gap | Detection | Resolution |
|-------|----------------|--------|-----------|------------|
| PR #382 predecessor (2026-06-12) | `scripts/install-sim-smoke.mjs`, `mcp-server/mcp-json-resolver.test.sh` | Both CI jobs red (scripts structurally coupled to stdio launch shape; broke on HTTP form) | CI (local verify: CLEAN) | Explicitly ran both scripts in verify; CI green |
| PR #423 (2026-06-27) | `hooks/**/*.test.sh` suites | Duplicate test file caught by CI's `shell` job, not locally | Reviewer (BLOCKING) | Duplicate deleted; `hooks/shell-test-gate.sh` now closes this sub-class deterministically |

PR #423 closed the `hooks/**/*.test.sh` class via the shell-test-gate. The PR #382 class (separate-CI-job scripts) remains the subject of this convention.

## Examples

**In-scope separate-CI-job scripts (as of 2026-06-27):**

```
scripts/install-sim-smoke.mjs          — CI: "install-sim" job
mcp-server/mcp-json-resolver.test.sh   — CI: "shell" job (standalone script, NOT hooks/**)
mcp-server/boot.test.sh                — CI: "boot" job
mcp-server/boot.e2e.test.sh            — CI: "boot-e2e" job
mcp-server/plugin-dir-resolver.test.sh — CI: "plugin-dir-resolver" job
```

**Bad — touches `install-sim-smoke.mjs`, does not run it in verify:**

```bash
# verify step
npm run build && npm run lint && npm test && bash hooks/lint.sh \
  && bash hooks/dead-wire-gate.sh "$BASE" \
  && bash hooks/shell-test-gate.sh "$BASE"
# ↑ passes locally — install-sim was never invoked.
# CI's install-sim job fires and is red.
```

**Good — explicitly runs the changed script in verify:**

```bash
# verify step (after touching scripts/install-sim-smoke.mjs)
npm run build && npm run lint && npm test && bash hooks/lint.sh \
  && bash hooks/dead-wire-gate.sh "$BASE" \
  && bash hooks/shell-test-gate.sh "$BASE"

# changed scripts — explicit execution:
node scripts/install-sim-smoke.mjs --self-check    # environment-safe smoke mode (exits 0)
bash mcp-server/mcp-json-resolver.test.sh           # standalone test suite
```

Note: run `install-sim-smoke.mjs --self-check` (the environment-safe sub-test mode) when the normal mode has environment-conditional exit codes. Confirm the sub-test exits 0; also note the expected exit code of the full run (e.g., exit 1 on Node == pin) and confirm it matches CI's behavior.

## Exceptions

A build that modifies a separate-CI-job script for a documentation-only reason (e.g., updating a comment or help string with no behavioral change) may defer explicit execution if the diff is provably non-behavioral. The engineer must state this explicitly in the SUMMARY: "Changed only comments/docstrings in `<script>` — no behavioral change, no execution needed."

Any behavioral change — flag parsing, output format, exit codes, invoked commands — requires explicit execution.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "`npm test` passes, so verify is done." | `npm test` runs vitest; it does not invoke shell or Node scripts in `scripts/` or `mcp-server/`. | Identify all separate-CI-job scripts the build touched; run each explicitly. |
| "`bash hooks/lint.sh` shellchecks the script — that's sufficient." | `shellcheck` checks syntax only; it does not execute the script or verify its runtime behavior. A script with correct syntax can still exit with the wrong code or produce wrong output. | Run the script — syntax passing and execution passing are different verdicts. |
| "The change is small and obviously correct." | PR #382: the change was structurally sound at the TypeScript layer; the break only surfaced in the shell scripts' runtime behavior against the new HTTP launch shape. "Obviously correct" is a prior probability; the CI job is the evidence. | Execute the changed script and observe its exit code before the review step. |
| "`hooks/shell-test-gate.sh` covers it." | `shell-test-gate.sh` covers `hooks/**/*.test.sh` suites only — scripts that live in `hooks/` and match `*.test.sh`. It does not invoke `scripts/install-sim-smoke.mjs`, `mcp-server/*.test.sh`, or any other separate-CI-job script. | Invoke the separate-CI-job script manually in verify. |

## Verification

- [ ] The build diff includes a changed file in `scripts/**` or `mcp-server/**/*.test.sh` or `mcp-server/**/*.e2e.test.sh`.
- [ ] If yes: the SUMMARY (or verify-step evidence) shows the script was explicitly invoked and its exit code confirmed.
- [ ] If the script has environment-conditional exit codes (e.g., `install-sim-smoke.mjs` exits 1 when Node == pin), the SUMMARY notes the expected vs observed exit code and confirms it matches CI's expected behavior.
- [ ] If the change was documentation-only, the SUMMARY explicitly states "no behavioral change — no execution needed."
- [ ] `hooks/**/*.test.sh` suites are NOT expected to be run manually here — `hooks/shell-test-gate.sh` covers them automatically (see `[[shell-test-gate]]`).

## Related

- `[[hooks-observable-failures]]` — sibling convention governing silent swallows in `hooks/**`; applies to the hook scripts themselves, not to verify-step scope.
- `[[probe-before-build-invoke-not-infer]]` — shared posture: invoke the capability, don't infer from environment inspection; this convention is the verify-step application of that posture.
