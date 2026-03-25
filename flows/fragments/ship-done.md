---
fragment: ship-done
description: Synthesize build artifacts into PR description and complete the flow
entry: ship

states:
  ship:
    type: single
    agent: canon-shipper
    effects:
      - type: persist_decisions
      - type: persist_patterns
    transitions:
      done: done
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### ship
Synthesize build artifacts into a PR description and optional changelog entry. Workspace: ${WORKSPACE}. Slug: ${slug}. Task: ${task}. Base commit: ${base_commit}. Required: session.json, board.json, *-SUMMARY.md. Optional (include if present): DESIGN.md, TEST-REPORT.md, REVIEW.md, SECURITY.md. Run `git log --oneline ${base_commit}..HEAD` for commit history. Check CHANGELOG.md in project root for format detection if it exists.
