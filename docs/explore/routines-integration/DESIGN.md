## Status: Complete

# Routines as a First-Class Canon-Managed Artifact Class

> EXPLORE design (2026-06-08), **not a committed build**. Author: canon-architect.
> Authority level per `docs/explore/CLAUDE.md`: **Open** — input to design, not settled.
> Reconciles against **Ratified** `workflow-integration/SYNTHESIS.md` (Inc-6 `canon-maintenance`)
> and **Parked** `adaptive-queen.md`. Session-cron `/loop` (`docs/explore/loop-integration/DESIGN.md`)
> is a **sibling system this document does NOT touch or subsume.**

**Primary recommendation:** Part I (§A–§F). **Supporting analysis:** Part II (the candidate-flow
capability/decision-matrix that motivates the binding rule).

---

## ASSUMPTIONS

1. **A routine is a durable scheduled agent — two runtime targets only: cloud routine
   (`/schedule`, runs on the user's Claude account, machine can be off) and desktop scheduled
   task (`~/.claude/scheduled-tasks/<name>/SKILL.md`, runs locally, app must be running).**
   Session-cron `/loop` is explicitly OUT of scope (sibling, `loop-integration/DESIGN.md`).
2. **A plugin cannot declaratively ship a cloud routine** (account-scoped, no manifest field) and
   can only *pre-populate* a desktop-task SKILL.md (the user still attaches the schedule). →
   Therefore Canon's value is to become the **authoring + management layer**: it authors the
   routine as a versioned in-repo artifact and binds/syncs it to the live runtime. This is the
   thesis; if it's wrong, the design is unmotivated.
3. **Canon's existing artifact-management pattern is the right model to mirror** — verified:
   principles, agent-rules, and commands are all file-based (frontmatter + body) artifacts with a
   managed taxonomy index, MCP discovery, glob loading with project-local precedence, and a
   content-flow authoring path via the `writer`. A routine should be a peer of these (§A).
4. **`.canon/**` is fully gitignored** (`.gitignore:28`, `**/.canon/**`, sole negation
   `!.canon/principle-overrides.yaml`). → Routine *definitions* live in a **tracked** dir;
   routine *run history* lives in **gitignored** `.canon/` (mirrors `principles/` vs
   `.canon/drift.db`).
5. **No routine may reconfigure a running build** — the parked Adaptive Queen boundary
   (`adaptive-queen.md` §2) is an immutable, CI-linted schema invariant (§A.3, §F.2).
6. **Cloud routines run on the user's Claude account, needing no CI API key** (brief; user noted
   "no API key for now"). This makes the **cloud routine the preferred durable target** for
   eligible jobs — it sidesteps the GitHub-Action `ANTHROPIC_API_KEY` secret entirely.

→ Assumptions 2 (authoring-layer thesis) and 6 (cloud needs no key) most shape the recommendation.
Correct them first.

---

# PART I — Routines as a Managed Artifact Class (primary recommendation)

## §A. The artifact itself — home + schema

### A.1 How Canon manages artifact classes today (verified — the pattern to mirror)

| Concern | Principles | Agent-rules | Commands | → **Routines (proposed)** |
|---|---|---|---|---|
| **Definition** | file, frontmatter + body | file, frontmatter + body | file, frontmatter + body | file, frontmatter + body |
| **Home (tracked)** | `principles/{rules,strong-opinions,conventions}/*.md` | `rules/agent-*.md` | `skills/canon/commands/*.md` | **`routines/*.md`** (§A.2) |
| **Project-local / override** | `.canon/principles/**` precedence (`principle-loading.md:31,44`) | — | — | **`.canon/routines/**`** (§A.2) |
| **Managed index** | dir + CLAUDE.md | `rules/.claude/CLAUDE.md` ("Managed by Canon. Manual edits preserved.") | commands dir | **`routines/.claude/CLAUDE.md`** (managed) |
| **Discovery (MCP)** | `get_principles`, `list_principles` (`principle-loading.md:7,24`) | spawner selects by agent/state | slash registry | **`list_routines`, `get_routine`** (§C) |
| **Authoring path** | `writer` via content-flow (`content-flow.md:84`) | `writer` (new-agent-rule mode) | hand-authored | **`writer` (routine mode) via content-flow** (§B) |
| **Runtime state** | `.canon/drift.db` (gitignored) | n/a | n/a | **`.canon/routines-state/` (run history), gitignored** (§C.4) |

The pattern is consistent: **tracked file = versioned source of truth; `.canon/` = runtime state;
a "Managed by Canon" index; MCP discovery; a content-flow authoring path via the writer.** A
routine slots into every column — it is a **fifth member of an existing artifact family, not a new
paradigm.** This is the core evidence the abstraction holds.

### A.2 Home

- **Tracked definitions:** `routines/<name>.md` (repo root, peer of `principles/`, `rules/`,
  `agents/`). Plugin-shipped routines live here, versioned and code-reviewed.
- **Project-local + override:** `.canon/routines/<name>.md` takes precedence on name conflict
  (mirrors `.canon/principles/**`, `principle-loading.md:31`). User-private routines + overrides.
- **Managed index:** `routines/.claude/CLAUDE.md` — generated, "Managed by Canon. Manual edits
  preserved." header exactly like `rules/.claude/CLAUDE.md`.

### A.3 Schema (frontmatter declares intent; body is the prompt the routine fires)

```markdown
---
name: release-ahead                    # unique kebab-case (peer of a principle id)
title: Release-ahead check
status: enabled                        # enabled | disabled | draft  (lifecycle, §C)

# --- TRIGGER: when does it fire? ---
trigger:
  kind: schedule                       # schedule | github-event | api
  cron: "0 9 * * *"                    # for kind:schedule (5-field cron or preset)
  event: ~                             # for kind:github-event (e.g. pull_request.opened)
  # api trigger → endpoint+token, recipe-only (cannot be plugin-bundled)

# --- BINDING NEEDS: Canon DERIVES the target from these (§D) ---
needs:
  state: git-native                    # git-native | local-canon
  daemon: false                        # true → desktop-task-only until A3-headless probe green
binding_target: ~                      # OPTIONAL override; normally Canon-resolved + written back
                                       #   resolved ∈ { cloud-routine | desktop-task }

repos: [canon]                         # scope: which repo(s) the routine clones/operates on
scope: repo                            # repo | account

# --- GUARDRAILS (inherited floor, §A.4) ---
guardrails:
  mutates_running_build: false         # ALWAYS false; CI-linted (adaptive-queen invariant)
  repo_writes: notify-only             # notify-only | draft-pr | none ; NEVER merge/approve/push-main
  consent: opt-in                      # opt-in | tier-gated ; durable+repo-writing defaults opt-in

# --- TERMINATION / RECURRENCE ---
recurrence: standing                   # standing (recurs on schedule) | one-shot
---

## Routine: Release-ahead check

### Intent
{One paragraph: what this routine does each run and what it notifies/drafts.}

### Body (the prompt the routine fires per run)
{The exact instructions the bound runtime executes — read repo state, compute, draft-PR or notify.
Written to be runnable from a FRESH CLONE (cloud) or LOCAL tree (desktop) per the resolved binding.}

### Guardrail notes
{Why repo_writes is set as it is; what it will never do.}
```

### A.4 The guardrail floor (schema-enforced, CI-linted — peer of the `workflows/` lint in SYNTHESIS §3.1)

1. **`mutates_running_build: false` mandatory + immutable** — the Adaptive Queen boundary as a
   lint rule (§F.2). A routine observes/notifies/drafts; it never reconfigures a running build.
2. **`repo_writes` ∈ {notify-only, draft-pr, none}** — never merge/approve/push-main. This is the
   SYNTHESIS `canon-maintenance` guardrail ("draft-PR + notify, never silent merge", row 17)
   generalized to *every* routine.
3. **`consent` defaults to `opt-in` for durable repo-writing routines** — stricter than session
   loops, because "unattended + writes to repo" is the highest-risk combination (§F.1, Open Q4).

---

## §B. Authoring

**Recommendation: extend the `writer` with a routine-authoring mode; add a `/canon:routine`
command + `templates/routine.md` + a `content-flow/routine` variant. No new agent.**

The `writer` already authors principles, conventions, and agent-rules — frontmatter+body Canon
artifacts — via the content-flow (`content-flow.md:84`; `agents/writer.md`), and explicitly owns
"conflict detection and format validation … consistently" (`content-flow.md:42`). A routine is the
same kind of artifact. A dedicated `canon:routine-author` would duplicate that machinery.

| Concern | Principle authoring (today) | Routine authoring (proposed) |
|---|---|---|
| Command | `/canon:edit-principle` (`skills/canon/commands/edit-principle.md`) | **`/canon:routine`** (new peer) |
| Flow | content-flow/principle (`content-flow.md:84`) | **content-flow/routine** (new variant) |
| Agent | `writer` | **`writer` (routine mode)** |
| Template | principle template | **`templates/routine.md`** (peer of `templates/prd.md`) |
| Validation | conflict detection, severity, format | binding-needs↔target coherence, guardrail-floor, fresh-clone-runnability |

**`templates/routine.md`** defines the §A.3 schema as required output, with an interview the writer
runs: *what does it do each run? trigger (cron/GitHub event)? what state does it read/write (→
derives cloud-vs-desktop binding)? what does it notify/draft? consent posture? which repos?* The
interview maps 1:1 to frontmatter — authoring is "fill frontmatter via interview, then write the
body prompt," exactly the principle-authoring ergonomics.

**`content-flow/routine` variant:** `research → implement (writer, routine mode) → review →
context-sync → learn` — reuses the existing content-flow machinery verbatim (`content-flow.md:27`).
Review enforces the guardrail floor (§A.4) and **fresh-clone-runnability** (for cloud-bound
routines, the body must not assume `.canon/` exists — §D).

**Open Q2:** extend-writer (my lean) vs new `canon:routine-author` agent if binding-generation
(cron synthesis, SKILL.md emission, `/schedule` recipe) grows heavy.

---

## §C. Management / lifecycle

The artifact is the **source of truth**; the live binding is **generated/synced FROM it** (one
direction), mirroring how `rules/.claude/CLAUDE.md` is generated from rule files.

### C.1 Create / update
Via §B (`/canon:routine` → writer → content-flow). Produces/edits `routines/<name>.md` (tracked)
or `.canon/routines/<name>.md` (private). On save, sync (§C.3) regenerates the binding.

### C.2 List / status — `/canon:routines` + `list_routines` MCP tool
A `/canon:routines` command (shape of `skills/canon/commands/check.md`) + `list_routines` MCP tool
(peer of `list_principles`, `principle-loading.md:24`) surface: each routine's name, status,
resolved binding target, last run, and **drift between artifact and live binding** — e.g.,
`routines/x.md` enabled but no live cloud routine / desktop SKILL.md present → "unbound"; a live
binding with no backing artifact → "orphan."

### C.3 Enable / disable / delete + the sync model
- **Enable/disable** = flip `status:` in the artifact, then sync.
- **Delete** = remove the artifact, then sync removes/flags the binding.
- **Sync** generates/updates/removes the concrete binding FROM the artifact:
  - `binding_target: cloud-routine` → **emit a `/schedule` recipe** (name + body prompt + repos +
    triggers) for the user to register on their account. **Cannot auto-create** — account resource
    (capability finding). Sync's job is to keep the recipe current and detect drift, not to create.
  - `binding_target: desktop-task` → **write/refresh `~/.claude/scheduled-tasks/<name>/SKILL.md`**
    from the body. The user attaches the schedule (the one irreducible manual step).

**When does sync run?** Open Q3. **My lean: detect-and-nudge at session start** (a SessionStart
hook, peer of `session-start-kg-check.sh`, compares `routines/*.md` against live bindings and
nudges), **apply only on explicit `/canon:routines sync`** — silently writing scheduled-task files
or emitting account recipes at session start is a surprise side-effect Canon avoids.

### C.4 Run history — where it lives (gitignored)
Definitions are tracked (`routines/`); run history is gitignored runtime state under
**`.canon/routines-state/<name>.json`** (last-run timestamp, last outcome, last-seen snapshot for
notify-on-change, draft-PR URLs opened) — mirroring `.canon/drift.db` (runtime) vs `principles/`
(definitions). **Cloud-routine caveat:** a cloud run's fresh clone has no `.canon/`, so cloud-bound
routines that need run-to-run memory must persist it in the repo (a tracked tracking-issue / a
`claude/*` branch marker) rather than `.canon/` — a fresh-clone-runnability constraint the review
step enforces. Desktop-bound routines use `.canon/routines-state/` normally.

---

## §D. Mechanism binding — one artifact, two durable targets, derived

The artifact declares `needs:` (state, daemon); Canon applies the **capability gate** (verified in
Part II §0.3) as a resolver:

```
resolveBinding(needs):
  if needs.state == git-native and not needs.daemon:  → cloud-routine   (preferred — no CI key, runs machine-off)
  else:  # local-canon state OR needs daemon            → desktop-task    (local FS/.canon/daemon access)
```

- **Cloud-routine** wins when the job is **git-native AND daemon-free** — its entire input is the
  cloned repo and its entire output is a notify/draft-PR. Runs on the user's account (no
  `ANTHROPIC_API_KEY` secret — Assumption 6), survives machine-off. **Preferred durable target.**
- **Desktop-task** is forced when the job needs **`.canon/` state or the MCP daemon** — a fresh
  cloud clone has neither (gitignore collision §0.3; headless daemon unproven). Pre-populated
  SKILL.md; manual schedule attach.

`binding_target` is normally `~` and **written back by the resolver** (auditable). An explicit
override is validated against `needs` — declaring `cloud-routine` while `daemon:true` or
`state:local-canon` is a **hard CI error** (the capability gate encodes verified infeasibility, not
preference — Open Q5). This is the Part II decision matrix mechanized as a function the artifact
class applies, so **new routines resolve their target automatically.**

---

## §E. Subsuming the candidate flows (proof the abstraction holds)

The six candidate background flows (Part II) stop being hypothetical hardcoded features and become
**instances of the routine artifact class.** Three re-expressed:

### E.1 `routines/release-ahead.md` (Part II rec #1)
```yaml
name: release-ahead
trigger: { kind: schedule, cron: "0 9 * * *" }
needs: { state: git-native, daemon: false }
guardrails: { mutates_running_build: false, repo_writes: notify-only, consent: opt-in }
repos: [canon]; recurrence: standing
```
Body = "from the clone, run `git rev-list --count $(git describe --tags --abbrev=0)..HEAD`; if >0,
open/update a tracking issue." **Resolved binding: cloud-routine** (git-native + daemon-free +
no-key) — the preferred target. Subsumes Part II's standalone-Action proposal; the routine artifact
is the source of truth and the `/schedule` recipe is generated from it.

### E.2 `routines/pr-review.md` (Part II rec #2)
```yaml
name: pr-review
trigger: { kind: github-event, event: "pull_request.opened|synchronize" }
needs: { state: git-native, daemon: false }   # principles via ${CLAUDE_PLUGIN_ROOT}/** glob fallback
guardrails: { mutates_running_build: false, repo_writes: notify-only, consent: opt-in }
repos: [canon]; recurrence: standing
```
Body = the Canon reviewer prompt against the PR diff, principles loaded via the
`${CLAUDE_PLUGIN_ROOT}/principles/**` glob fallback (`pr-review.md` already specifies it), posts a
single review **comment** (never an approving review). Drop `--incremental` (it reads gitignored
`.canon/reviews.jsonl`, `pr-review.md:26`). **Resolved binding: cloud-routine** (GitHub-event
trigger, git-native, no-key — directly satisfies "no API key for now").

### E.3 `routines/canon-maintenance.md` (the ratified Inc-6 item — §F.1)
```yaml
name: canon-maintenance
trigger: { kind: schedule, cron: "0 3 * * *" }
needs: { state: local-canon, daemon: true }   # scribe marker + janitor worktrees + drift db
guardrails: { mutates_running_build: false, repo_writes: draft-pr, consent: opt-in }
repos: [canon]; recurrence: standing
```
Body = scribe doc-sync → janitor prune → optional drift sweep, draft-PR + notify. **Resolved
binding: desktop-task** (local-canon state + daemon → cloud impossible; matches Part II §A.1's
finding and SYNTHESIS's headless-MCP precondition). Sync writes
`~/.claude/scheduled-tasks/canon-maintenance/SKILL.md`.

**The abstraction holds:** a daemon-free git-native scheduled job (→ cloud), a GitHub-event review
job (→ cloud), and a daemon-bound local-state hygiene composite (→ desktop) — all the same artifact
class, differing only in declared `needs`/`trigger`, each resolving its binding automatically.

---

## §F. Reconciliation

### F.1 vs Inc-6 `canon-maintenance` (Ratified) — it becomes ONE managed routine
SYNTHESIS row 17 / §8 Q4 ratified `canon-maintenance` as a CronCreate-scheduled hygiene flow
(scribe/janitor/re-index), "draft-PR + notify, never silent merge," gated behind a headless-MCP
probe. Under this design, **`canon-maintenance` is no longer a hardcoded feature — it is a single
managed routine artifact** `routines/canon-maintenance.md` (§E.3) whose guardrails ARE the schema
floor (§A.4) and whose binding resolves to **desktop-task** (honoring the same headless-MCP
precondition SYNTHESIS already states — until A3-headless is green, the daemon-needing members stay
desktop, not cloud). **This *implements* the ratified decision through the artifact class — a
refinement, not a contradiction:** SYNTHESIS decided *what* it does + guardrails; this design
provides the *managed mechanism* it is authored and bound through.

> **Note on the `workflows/` library (SYNTHESIS §3.1):** routines and workflows are orthogonal
> layers. A *workflow* is a hand-written plain-JS execution graph for one build's steps. A
> *routine* is the recurring *scheduling + management envelope*; its body could eventually invoke
> a workflow. The routine schedules; the workflow does the work. No conflict.

### F.2 vs Adaptive Queen (Parked) — the boundary becomes a schema invariant
The Adaptive Queen was parked because a standing monitor that *reconfigures a running swarm* fights
determinism (`adaptive-queen.md` §2). This design **encodes that boundary as
`mutates_running_build: false`, mandatory + CI-linted (§A.4)** — making the parked failure mode
**unrepresentable**, not merely discouraged. A routine runs *between* builds (hygiene) or on
*external events* (PR opened); it never touches an in-flight build's path.

### F.3 vs `/loop` (sibling — NOT touched)
Session-cron `/loop` (`loop-integration/DESIGN.md`) is a **separate system this document does not
redesign or subsume.** The clean division: `/loop` = *attended, session-local, dies on session
exit*; routines = *unattended, durable, survive machine-off (cloud) or app-restart (desktop)*. The
two artifact systems may converge later (a shared "Canon-managed scheduled artifact" abstraction),
but that is explicitly out of scope here. **Routines do not absorb the `/loop` watchers.**

---

## §G. Ranked recommendation + build scope

1. **`routines/release-ahead.md` → cloud-routine** (XS body, no key, closes `sug_EEEE2`). The
   cheapest end-to-end proof of the artifact→binding pipeline on the preferred target.
2. **`routines/pr-review.md` → cloud-routine** (S; GitHub-event, no key — satisfies "no API key").
3. **`routines/canon-maintenance.md` → desktop-task** (M; realizes ratified Inc-6).

**First-build scope (Open Q6) — my lean: thin slice.** Ship the artifact class minimally: the
schema + `routines/` dir + CI lint + `templates/routine.md` + writer routine-mode + one routine
(`release-ahead`) bound to cloud-routine via a generated `/schedule` recipe — proving
artifact→binding end-to-end on the no-key target. Then grow management surface (`/canon:routines`,
`list_routines`, sync hook) and the desktop binding (canon-maintenance) in follow-ons. Mirrors
SYNTHESIS's own probe-first / increment discipline.

---

## §H. Open questions (HAS_QUESTIONS)

**Q1 — Artifact home: `routines/` (tracked) vs `.canon/routines/` (gitignored) vs both?** §A.2
proposes **both** — `routines/` for plugin-shipped + tracked project routines (versioned,
reviewable; a routine that opens PRs deserves code review), `.canon/routines/` for private +
override (precedence, like `.canon/principles/`). **My lean: both, tracked-primary.**

**Q2 — Authoring: extend `writer` (routine mode) vs new `canon:routine-author`?** §B leans
**extend the writer** — it already owns frontmatter+body Canon-artifact authoring with conflict
detection + format validation (`content-flow.md:42`). Dedicated agent only if binding-generation
(cron synthesis, SKILL.md emission, `/schedule` recipe) grows heavy. **My lean: extend.**

**Q3 — Sync model: session-start auto-reconcile vs explicit `/canon:routines sync`?** §C.3 leans
**detect+nudge at session start, apply on explicit command** — silently emitting account recipes
or writing `~/.claude/scheduled-tasks/` files is a surprise side-effect. **My lean:
nudge-then-explicit-apply.** This is the one real magic-vs-control tradeoff.

**Q4 — Default consent for durable repo-writing routines.** §A.4 sets `consent: opt-in` (stricter
than `/loop`'s tier-gated) and `repo_writes` floor at notify-only/draft-pr (never merge), because
"unattended + writes to repo" is the highest-risk combination. **My lean: opt-in default for any
durable routine that writes to the repo**, inheriting the SYNTHESIS canon-maintenance posture
uniformly. Confirm.

**Q5 — Override validation strictness.** §D lets a routine override the resolved `binding_target`,
validated against `needs` (cloud + daemon/local-canon → error). Hard CI failure (my lean — the gate
encodes verified infeasibility, Part II §0.3) or an acceptable warning?

**Q6 — First-build scope: thin slice vs full management layer?** §G leans **thin slice** — schema +
one routine + cloud binding via recipe, then grow management + desktop binding. Confirm.

**Q7 — Cloud-routine run-to-run memory.** §C.4: a cloud run's fresh clone has no `.canon/`, so a
cloud routine needing memory must persist it in-repo (tracking issue / `claude/*` branch marker).
Is the user OK with cloud routines writing such markers (within the notify/draft-PR guardrail), or
should cloud routines be **strictly stateless** (each run independent, no memory)? **My lean: allow
in-repo markers within the guardrail** — release-ahead's "tracking issue" is exactly this and is
benign.

---

# PART II — Supporting analysis: candidate-flow capability + decision matrix

> This is the capability finding that motivates Part I's binding rule (§D). It establishes which
> flows are cloud-eligible vs desktop-only by verifying each flow's state/daemon needs against the
> codebase. The matrix below is now mechanized as the §D resolver.

## §0. Verified ground truth

### 0.1 The two durable mechanisms (cloud routine / desktop task)

| Mechanism | Runs where | Local state? | Bundleable? | Needs CI key? | Triggers |
|---|---|---|---|---|---|
| **Cloud routine** (`/schedule`) | Anthropic cloud (machine can be off) | **NO** — fresh clone of default branch, no `.canon/` | **NO** — account resource; ship a recipe | **No** — runs on user's account | cron / GitHub event / API |
| **Desktop scheduled task** | user's machine (app running) | **YES** — full FS/`.canon/`/worktree/daemon | **PARTIAL** — pre-populate `~/.claude/scheduled-tasks/<name>/SKILL.md`; user attaches schedule | n/a (local) | local schedule |

(Session-cron `/loop` is the sibling system, out of scope — `loop-integration/DESIGN.md`.)

### 0.2 What each candidate flow reads/writes (verified)

| Flow | Reads | Writes | State location | Daemon? | Source |
|---|---|---|---|---|---|
| **Scribe doc-sync** | git diff, summaries, CLAUDE.md/context.md/CONVENTIONS.md | `docs(context-sync):` commit; `.canon/last-scribe-commit` | git tree **+** gitignored marker | No for the edit | `agents/scribe.md`; `session-start-doc-check.sh:21,47` |
| **Learner sweep** | `.canon/drift.db`, `.canon/reviews.jsonl`, `.canon/learning.jsonl`, KG | `.canon/LEARNING-REPORT.md`, `learning.jsonl`, `proposed-learnings/` | **entirely `.canon/`** | **Yes** | `agents/learner.md` tools + write scope |
| **Drift sweep + auto-resolve** | `.canon/drift.db` (SQLite + WAL) | drift store mutations | **`.canon/drift.db`** | **Yes** | `.canon/drift.db`, `.canon/drift.db-wal` present |
| **Janitor prune** | `git worktree list`, `.canon/worktrees/`, `.canon/workspaces/` | deletes under those dirs | **local worktrees/workspaces** | `invoke_janitor` signal | `agents/janitor.md:4-8,33,49-55` |
| **Release-ahead** | `git rev-list`, tags | notify only | none (pure git) | **No** | `project_release_bump_lockfile_gap` (sug_EEEE2) |
| **Autonomous PR review** | PR diff, principles | `gh pr comment`; `.canon/reviews.jsonl` (only `--incremental`) | principles bundled; incremental reads gitignored | **Partial** — falls back to `${CLAUDE_PLUGIN_ROOT}/principles/**` glob | `pr-review.md:26` |

### 0.3 The two load-bearing facts → the capability gate

1. **Gitignore collision (total).** `.gitignore:28` ignores `**/.canon/**`. A cloud routine's
   fresh clone has zero `.canon/` (no drift.db, knowledge-graph.db, learning.jsonl, reviews.jsonl,
   worktrees, workspaces). Any flow whose value depends on that state is structurally impossible as
   a cloud routine.
2. **Headless daemon unproven.** Flag-dark daemon shipped (`project_http_epic_phase2_shipped`) but
   boot is fragile (`project_mcp_boot_root_cause_pinned`); SYNTHESIS row 17 gates
   `canon-maintenance` behind an A3-headless probe. Until green, no cloud routine may depend on the
   daemon.

**→ The capability gate (mechanized as §D's resolver):** cloud-eligible **iff git-native AND
daemon-free**; else desktop-task.

## §1. Decision matrix — candidate flows

| Flow | Resolved binding | State needs | Daemon? | Guardrails | vs Inc-6 canon-maintenance |
|---|---|---|---|---|---|
| **Scribe doc-sync** | **desktop-task** | reads gitignored `last-scribe-commit` marker → cloud can't tell when it last ran | No (edit) | draft-PR + notify | **canonical member** — named in SYNTHESIS row 17 |
| **Learner sweep** | **desktop-task** | all `.canon/` | **Yes** | `.canon/` proposals, no push | Adjacent; `canon-learn-mine` (Inc 5) covers per-build path. *Scheduled* sweep is new. |
| **Drift sweep** | **desktop-task** (sweep); auto-resolve **not yet durable** | `.canon/drift.db` | **Yes** | auto-resolve must draft-PR | re-index lane; local → desktop |
| **Janitor prune** | **desktop-task ONLY** | local worktrees/workspaces | signal | deletes only `.canon/worktrees`+`workspaces` (`agents/janitor.md:33`) | named in SYNTHESIS row 17; **cloud impossible** (no worktrees in clone) |
| **Release-ahead** | **cloud-routine** | pure git | No | notify only | new; targets `sug_EEEE2` |
| **Autonomous PR review** | **cloud-routine** | git-native; drop `--incremental` | No (glob fallback) | comment only, never approve | distinct event-review lane; NOT maintenance |

**Headline finding (motivates the whole design):** of six candidates, **only two (release-ahead,
PR review) are cloud-eligible** — exactly the git-native, daemon-free ones. The four Canon-ish
hygiene flows are `.canon`/daemon-bound → desktop-task — the lane SYNTHESIS already reserves for
`canon-maintenance`. Part I makes all six *instances of one managed artifact class* rather than six
bespoke features, with the binding (cloud vs desktop) derived from these verified needs.

---

### Status

DONE (exploration — design record written, not a committed build).

**Artifact:** `docs/explore/routines-integration/DESIGN.md`

**Summary:** Re-aimed per course-correction onto **routines** (durable scheduled agents: cloud
routine via `/schedule`, desktop scheduled task via `~/.claude/scheduled-tasks/<name>/SKILL.md`);
session-cron `/loop` is treated as a **sibling system, not touched or subsumed**. Primary
recommendation (Part I): make **"routine" a first-class Canon-managed artifact class** — a fifth
member of the existing artifact family (principles, agent-rules, commands, agents), authored and
managed the same way. **Verified pattern mirrored:** file-based frontmatter+body artifacts with
tracked definitions, `.canon/` runtime state, a "Managed by Canon" index (`rules/.claude/CLAUDE.md`),
MCP discovery (`get_principles`/`list_principles`, `principle-loading.md:7,24`), glob loading with
project-local precedence (`.canon/principles/**`, `principle-loading.md:31`), content-flow authoring
via the `writer` (`content-flow.md:84`). **Schema + home:** `routines/<name>.md` (tracked, +
`.canon/routines/**` private/override); frontmatter declares `trigger` (cron / github-event / api),
`needs` (state + daemon — from which Canon DERIVES the binding), `repos`/`scope`, `guardrails`
(CI-linted `mutates_running_build:false` = Adaptive Queen boundary made unrepresentable; `repo_writes`
notify-only/draft-pr, never merge; `consent` opt-in for durable repo writers); body = the prompt the
routine fires, written to be fresh-clone-runnable for cloud. **Authoring:** extend the `writer` with
a routine mode + `/canon:routine` + `templates/routine.md` + a `content-flow/routine` variant — no new
agent, no new flow primitive. **Management:** `/canon:routines` + `list_routines`/`get_routine` MCP
tools; artifact is source of truth, binding generated/synced FROM it (cloud → `/schedule` recipe,
cannot auto-create; desktop → write SKILL.md); detect-and-nudge at session start, apply on explicit
command; run history in gitignored `.canon/routines-state/` (cloud routines persist any memory
in-repo since the clone lacks `.canon/`). **Binding rule:** one artifact, two durable targets, DERIVED
— **git-native AND daemon-free → cloud-routine (preferred: no CI API key, runs machine-off); else
→ desktop-task.** **Subsumes the candidate flows:** release-ahead and pr-review re-expressed as
cloud-bound routines, canon-maintenance as a desktop-bound routine (§E) — proving the abstraction.
**Reconciliation:** Inc-6 `canon-maintenance` becomes ONE managed routine (the class *implements*
the ratified decision; binding = desktop-task honoring its headless-MCP precondition) — refinement,
not contradiction; Adaptive Queen boundary becomes the CI-linted schema invariant; `/loop` is a
sibling left untouched. Supporting analysis (Part II) retains the verified capability/decision-matrix
that motivates the binding rule. Seven open questions (artifact home, extend-writer-vs-new-agent,
sync model, default consent, override-validation strictness, thin-slice-vs-full first build,
cloud-routine run-to-run memory).
