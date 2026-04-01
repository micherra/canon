---
name: hotfix
description: Minimal-ceremony emergency fix — implement, verify, ship
tier: small

includes:
  - fragment: implement-verify
    with:
      after_all_passing: ship
    overrides:
      implement:
        template: implementation-log

  - fragment: ship-done
---

## Spawn Instructions

### implement
HOTFIX — direct mode, no plan file. Task: ${task}. This is a production issue — focus on the minimal correct fix. Do not refactor surrounding code. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

### verify
Verify the hotfix. Run the test suite — all existing tests must pass. Focus verification on the specific area fixed. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Report all_passing or implementation_issue. Do NOT write new tests — speed matters here.

### ship
Synthesize hotfix into a PR description. Workspace: ${WORKSPACE}. Slug: ${slug}. Task: ${task}. Base commit: ${base_commit}. Read SUMMARY.md and TEST-REPORT.md. Run `git log --oneline ${base_commit}..HEAD` for commit history. Mark as hotfix in the PR title.
