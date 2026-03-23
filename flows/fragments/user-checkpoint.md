---
fragment: user-checkpoint
description: Present work summary for user approval or revision feedback before proceeding
entry: checkpoint
params:
  after_approved: ~
  on_revise: ~

states:
  checkpoint:
    type: single
    agent: canon-guide
    role: checkpoint
    max_iterations: 3
    stuck_when: same_status
    transitions:
      approved: ${after_approved}
      revise: ${on_revise}
      has_questions: hitl
      blocked: hitl
---

## Spawn Instructions

### checkpoint
Checkpoint review for: ${task}.

Read workspace artifacts to understand current state:
- Design: ${WORKSPACE}/plans/${slug}/DESIGN.md (if exists)
- Task plans: ${WORKSPACE}/plans/${slug}/*-PLAN.md (if exist)
- Summaries: ${WORKSPACE}/plans/${slug}/*-SUMMARY.md (if exist)
- Research: ${WORKSPACE}/research/ (if exists)
- Prior revision notes: ${WORKSPACE}/plans/${slug}/REVISION-NOTES.md (if exists)

**If this is your first entry** (no user feedback provided yet):
- Produce a concise checkpoint summary: what's been done, what's planned next, key decisions made, and any trade-offs worth flagging
- Keep it scannable — use bullet points, not paragraphs
- End with a natural prompt inviting the user's thoughts — no jargon, no "say X to do Y" instructions
- Report `has_questions`

**If the user has provided feedback:**

Use semantic reasoning to classify the user's response — do not look for magic keywords.

- **approved**: The user is satisfied and wants to proceed. This includes enthusiastic agreement, simple affirmatives, or any response that signals "go ahead" without requesting changes.
- **revise**: The user wants something changed. This includes direct requests ("use postgres instead"), questions that imply concern ("wouldn't X be better?"), constraints ("it also needs to handle Y"), or any substantive feedback about the plan. When in doubt, treat it as a revision — it's better to incorporate feedback than to skip it.

On revise: save the user's feedback to ${WORKSPACE}/plans/${slug}/REVISION-NOTES.md (append if file exists), then report `revise`.

${progress}
