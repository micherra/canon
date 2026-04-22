---
fragment: ship-done
description: Synthesize build artifacts into PR description, optionally run learner, and complete the flow
entry: ship

states:
  ship:
    type: single
    agent: shipper
    transitions:
      done: learn
      blocked: hitl

  learn:
    type: single
    agent: learner
    skip_when: learn_gate_not_passed
    transitions:
      done: done
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### ship
Synthesize build artifacts into a PR description and optional changelog entry. Workspace: ${WORKSPACE}. Slug: ${slug}. Task: ${task}. Base commit: ${base_commit}. Required: session.json, board.json, *-SUMMARY.md. Optional (include if present): DESIGN.md, TEST-REPORT.md, REVIEW.md, SECURITY.md. Run `git log --oneline ${base_commit}..HEAD` for commit history. Check CHANGELOG.md in project root for format detection if it exists.

The shipper performs a pre-launch checklist (Step 1.5 in its process) before generating the PR description. If required checks fail, it reports BLOCKED.

### learn
You are in auto-trigger mode (ADR-016). Analyze recent flow transcripts and execution data to propose principle/convention updates.

1. Query the execution store for all transcript paths from this flow's completed states. Read the workspace orchestration.db at `${WORKSPACE}/orchestration.db` — the `execution_states` table has `transcript_path` columns for each state.
2. Use `get_history` to query recent flow execution history and decisions from drift.db.
3. Use `get_drift_report` to query recent drift data for principle health.
4. Analyze patterns across transcripts, history, and drift data.
5. Write proposals to `.canon/proposed-learnings/{timestamp}/` using the structured proposal format (Steps 5-6 from your agent definition).
6. Report DONE with a summary of proposals written. If no actionable patterns found, report DONE with "No proposals — insufficient evidence for suggestions."
