---
id: agent-missing-artifact
title: Missing Artifact Protocol
severity: rule
tags: [agent-behavior, artifacts, error-handling]
---

When an agent expects an artifact from a previous state and the file does not exist, the response depends on how critical the artifact is to the agent's work.

## Categories

1. **Required input** (agent cannot function without it): Report `BLOCKED` with detail: "Missing required artifact: {path}". Do not proceed with partial data.

2. **Optional input** (agent can degrade gracefully): Log a warning, skip the missing artifact, and note it in your output: "Artifact missing: {path} — proceeding without it."

3. **Cross-check input** (used for validation, not primary work): Skip the check, note it in your output, and do not change your primary verdict/result.

## Agent Classification

| Agent | Artifact | Category | Behavior |
|-------|----------|----------|----------|
| **canon-tester** | `*-SUMMARY.md` | Required | Report BLOCKED — cannot determine what to test without knowing what was implemented |
| **canon-reviewer** (Stage 3) | `*-SUMMARY.md` | Cross-check | Skip Stage 3 for that task, note in Cross-Check Notes: "Missing summary for {task_id} — cross-check skipped" |
| **canon-scribe** | `*-SUMMARY.md` | Optional | Proceed with git diff only, note in CONTEXT-SYNC.md: "Summary missing for {task_id} — sync based on git diff" |
| **canon-security** | `*-SUMMARY.md` | Optional | Scan code directly — security review is independent of summaries |
| **canon-architect** | `research/*.md` | Optional | Proceed with own codebase analysis if research directory doesn't exist |

## Rationale

Missing artifacts usually mean a previous agent crashed after partial work. Silently proceeding with missing data produces unreliable results. Silently blocking wastes time when the agent could have worked around it. The classification above balances reliability with forward progress.
