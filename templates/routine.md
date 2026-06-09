---
template: routine
description: Schema-as-template for Canon routine artifacts — fill this in when authoring a new routine via the writer
used-by: [writer]
read-by: [writer, reviewer]
output-path: routines/{name}.md
---

# Routine template

Use this template when authoring a new routine. Complete all required fields in the frontmatter
and fill the body sections below. The `writer` agent will interview you using the questions in
the "Writer interview" section and map each answer to a frontmatter field.

---

```markdown
---
name: {name}                         # Required. Unique kebab-case (peer of a principle id).
title: {Title}                       # Required. Human-readable display name.
status: draft                        # enabled | disabled | draft  (lifecycle managed by Canon)

# --- TRIGGER: when does it fire? ---
trigger:
  kind: schedule                     # schedule | github-event | api
  cron: "0 9 * * *"                  # For kind:schedule — 5-field cron expression or preset.
                                     # Remove if kind is not "schedule".
  event: ~                           # For kind:github-event — e.g. pull_request.opened
                                     # Remove or set to ~ if kind is not "github-event".

# --- BINDING NEEDS: Canon DERIVES the runtime target from these fields ---
# Canonical binding rule: mcp-server/src/features/routines/services/resolve-binding.ts
# git-native AND !daemon → cloud-routine; else → desktop-task
needs:
  state: git-native                  # git-native (needs a clone/checkout) | local-canon (needs local .canon/ state)
  daemon: false                      # true → requires a persistent local process → desktop-task only
binding_target: ~                    # Optional override. Normally Canon-resolved from `needs`.
                                     # Values: cloud-routine | desktop-task
                                     # Leave as ~ unless you have a specific reason to override.

repos: []                            # Required. List of repo slug(s) the routine operates on.
scope: repo                          # repo (applies to one or more repos) | account (applies account-wide)

# --- GUARDRAILS (enforced floor; mutates_running_build is CI-linted) ---
guardrails:
  mutates_running_build: false       # ALWAYS false. Canon CI-lints this. The adaptive-queen invariant.
  repo_writes: notify-only           # notify-only | draft-pr | none
                                     # NEVER merge/approve/push-to-main — that is a guardrail violation.
  consent: opt-in                    # opt-in | tier-gated
                                     # Durable routines with repo_writes should default to opt-in.

# --- TERMINATION / RECURRENCE ---
recurrence: standing                 # standing (recurs on every trigger) | one-shot (runs once then disabled)
---

## Routine: {Title}

### Intent
{One paragraph: what this routine does each run and what it produces — a notification, a draft PR,
or a status check. Be specific about the observable output.}

### Body
{The exact prompt the bound runtime executes per run. Written to be runnable from:
  - A FRESH CLONE (cloud-routine target): assumes a clean checkout, no local state.
  - A LOCAL TREE (desktop-task target): may read local .canon/ state, running builds, etc.
State which context this body assumes. If it depends on the resolved binding_target, say so.}

### Guardrail notes
{Optional. Explain any non-default guardrail choices. E.g., why repo_writes is draft-pr instead of
notify-only, or why consent is tier-gated. Leave empty if defaults are self-evident.}
```

---

## Writer interview

The `writer` agent asks these questions in order. Each question maps 1:1 to a frontmatter field.

| # | Question | Field |
|---|----------|-------|
| 1 | What does this routine do each time it runs? (One sentence — the observable output.) | `title`, `body` (Intent) |
| 2 | When should it fire — on a schedule, on a GitHub event, or via API call? | `trigger.kind` |
| 3 | If schedule: what cron expression? (e.g., daily at 09:00 → `"0 9 * * *"`) | `trigger.cron` |
| 4 | If github-event: which event? (e.g., `pull_request.opened`) | `trigger.event` |
| 5 | Does it need to read from a git repo (clone/checkout), or from local Canon state (.canon/)? | `needs.state` |
| 6 | Does it require a persistent local process (a running daemon)? | `needs.daemon` → affects `binding_target` |
| 7 | Which repo(s) does it operate on? | `repos` |
| 8 | Does it apply to one repo or to the whole account? | `scope` |
| 9 | What does it write back — nothing, a notification, or a draft PR? | `guardrails.repo_writes` |
| 10 | Should users opt in, or is it available by default to eligible tiers? | `guardrails.consent` |
| 11 | Does it recur on every trigger, or run once and stop? | `recurrence` |
