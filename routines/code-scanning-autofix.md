---
name: code-scanning-autofix
title: Code-Scanning Auto-Fix Check
status: enabled

trigger:
  kind: schedule
  cron: "0 9 * * 1"

needs:
  state: git-native
  daemon: false
binding_target: ~

repos: [canon]
scope: repo

guardrails:
  mutates_running_build: false
  repo_writes: draft-pr
  consent: opt-in

recurrence: standing
---

## Routine: Code-Scanning Auto-Fix Check

### Intent
Each Monday at 09:00 UTC, check the repository's open GitHub code-scanning (CodeQL) alerts. For
findings with a clear, well-understood fix, apply the remediation inline on a new branch and open a
draft pull request. For ambiguous findings (dismiss-vs-fix judgment calls, trust-boundary changes,
or non-obvious fixes), surface them in a tracking issue or PR comment and do NOT fix — cloud
routines have no interactive user to ask, so "ask first" degrades to "surface, don't fix". The
routine never merges, approves, or pushes to main — every remediation lands as a draft PR for
human review.

Autonomy posture mirrors the `auto-triage-fix` loop:
- **CLEAR finding → fix inline and open a draft PR WITHOUT asking.**
- **AMBIGUOUS finding → open/update a tracking issue to surface it; do NOT fix.**
- **NEVER auto-merge, approve, or push to main.** `repo_writes: draft-pr` is the hard ceiling.

### Body

This routine runs in a fresh clone of the canon repository. It does not require local state
directories or a running Canon MCP daemon. All GitHub API calls use the `gh` CLI authenticated
via the ambient GitHub token in the cloud environment.

#### Steps each run

1. **Fetch open alerts.**
   ```
   gh api 'repos/micherra/canon/code-scanning/alerts?state=open&per_page=100'
   ```

2. **If zero open alerts:** exit cleanly with a "code-scanning clean" log line.

3. **Classify each open alert** as CLEAR or AMBIGUOUS:
   - **CLEAR**: a deterministic, well-understood fix exists with no judgment call required. Examples:
     - `actions/missing-workflow-permissions` → add a least-privilege `permissions: contents: read`
       block to the affected workflow.
     - `js/path-injection` → add an input-validation barrier before fs access (allow-list pattern:
       reject empty, over-length, NUL/control-char, relative, or traversal-bearing inputs).
     - `js/clear-text-logging` in a pure test/smoke harness → replace env-derived interpolation
       with a redacted marker (e.g., `<redacted>`) to break the taint flow.
   - **AMBIGUOUS**: the correct disposition requires a judgment call (dismiss-vs-fix, false-positive
     assessment), the alert sits on a security trust boundary, or the fix is non-obvious.

4. **CLEAR findings — apply the fix inline:**
   - Create a new branch: `fix/code-scanning-<YYYYMMDD>`.
   - Apply each clear fix directly on that branch (edit the relevant file, commit with a descriptive
     message referencing the alert number and rule).
   - Open a **draft** pull request titled:
     `fix(security): resolve <N> code-scanning alert(s) [auto-fix <YYYYMMDD>]`
   - The PR description must list: alert numbers, rules, affected files, and a one-line summary of
     each fix applied.
   - **Never merge, approve, or push to main.** The PR is a draft for human review.

5. **AMBIGUOUS findings — surface, do not fix:**
   - Open or update a GitHub issue titled:
     `[code-scanning] Ambiguous alert(s) require human disposition — <YYYYMMDD>`
   - For each ambiguous alert, include: alert number, rule ID, severity, location, and why it is
     ambiguous (dismiss-vs-fix judgment, trust-boundary change, non-obvious fix).
   - Do not apply any code change for ambiguous findings.

6. **Mixed runs (CLEAR + AMBIGUOUS):**
   - Open the draft PR for clear findings (step 4).
   - Open or update the tracking issue for ambiguous findings (step 5).
   - Each output is independent — a failure in one does not block the other.

#### Guardrail notes

`repo_writes: draft-pr` — remediations land as draft PRs for human review only. The routine never
merges, approves, or pushes to main.

`needs.state: git-native` + `needs.daemon: false` — this routine runs in a fresh clone with no
local Canon state. All context comes from the repository checkout and the GitHub API.

`mutates_running_build: false` — this routine does not interact with running Canon builds. It
operates only on CodeQL alert data and repository files.

**Never auto-merge guardrail**: the routine MUST NOT call `gh pr merge`, `gh pr review --approve`,
or push directly to the `main` branch under any circumstances. This guardrail is unconditional.
