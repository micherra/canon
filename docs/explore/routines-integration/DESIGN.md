## Status: Complete

# Claude Code Routines — Canon Integration Exploration

> EXPLORE design exploration (2026-06-08), **not a committed build**. Author: canon-architect.
> Authority level per `docs/explore/CLAUDE.md`: **Open** — input to design, not settled.
> The durable/detached cousin of `docs/explore/loop-integration/DESIGN.md` (session-local `/loop`).
> Reconciles against the **Ratified** `workflow-integration/SYNTHESIS.md` (Inc-6 `canon-maintenance`)
> and the **Parked** `adaptive-queen.md` — refines/extends, does not contradict.

This is a thinking artifact for the user to react to. Every Canon-side claim is grounded
in a verified file path. The central question: **which Canon background flows should become
durable scheduled jobs, how do they split across the three scheduling mechanisms, and — given
that cloud routines cannot be bundled in a plugin — how does Canon ship the recipes to users?**

---

## ASSUMPTIONS

1. **The three-mechanism model from the brief is ground truth** (cloud routines / desktop
   scheduled tasks / session cron). I treat the brief's authoritative routines facts as given
   and verify only the *Canon-side* claims against the codebase.
2. **`.canon/**` is fully gitignored** — verified against `.gitignore:28` (`**/.canon/**`,
   sole negation `!.canon/principle-overrides.yaml`). Therefore *any* flow whose state lives
   under `.canon/` is invisible to a fresh cloud clone. This is the load-bearing constraint
   for the entire matrix.
3. **The MCP daemon's headless-boot feasibility is genuinely uncertain.** Memory records a long
   tsx-boot saga (`project_mcp_boot_*`, `project_tsx_boot_investigation_paused`) and the
   SYNTHESIS itself gates `canon-maintenance` behind "extend `canon-probe` to headless MCP
   availability (A3-headless) and green" (SYNTHESIS §4d, row 17). I treat headless daemon boot
   as **unproven** and design around it — a flow that *needs* the daemon headlessly is not yet
   a cloud-routine candidate.
4. **"Bundling" means shipping the recipe, never the routine.** Cloud routines are account
   resources with no manifest field; desktop tasks can be pre-populated as a SKILL.md but the
   schedule must be attached by the user; GitHub Actions ship as committed `.yml`. I assume the
   user accepts "recipe, not routine" as the only honest bundling story.
5. **Autonomous push posture is the user's call, not mine to assume.** SYNTHESIS guardrails
   `canon-maintenance` as "draft-PR + notify, never silent merge." I assume that guardrail is
   the floor for *every* durable job that mutates the repo, and surface the consent model as an
   open question rather than presuming it.

→ These assumptions shape everything below. Assumption 2 (gitignore) and Assumption 3 (headless
daemon unproven) are the two that, if wrong, would most change the matrix. Correct them first.

---

## 0. Shared ground truth (verified against the codebase, not guessed)

### 0.1 The three scheduling mechanisms (from the brief — authoritative)

| Mechanism | Runs where | Survives | Local state? | Bundleable? | Triggers |
|---|---|---|---|---|---|
| **Cloud routine** (`/schedule`) | Anthropic cloud infra (machine can be off) | account-scoped, durable | **NO** — fresh clone of default branch, no `.canon/`, no worktrees | **NO** — account resource, no manifest field | cron / API endpoint+token / GitHub events |
| **Desktop scheduled task** | user's machine (app must be running) | survives app restart | **YES** — full FS/`.canon/`/worktree access | **PARTIAL** — plugin can pre-populate `~/.claude/scheduled-tasks/<name>/SKILL.md`; user attaches schedule manually | local schedule |
| **Session cron** (`/loop`, CronCreate) | local interactive session | dies on session exit, 7-day expiry | YES | not a distribution mechanism | turn-driven / ScheduleWakeup |

Session cron is the subject of the **companion** `loop-integration/DESIGN.md` and is **out of
scope here** except for the reconciliation in §4. This document covers the two *durable* lanes:
cloud routine and desktop task, plus the third bundling vehicle that is neither — **GitHub
Actions** (committed `.yml`, run on GitHub's runners, fully bundleable, repo-state-native).

### 0.2 What each candidate flow actually reads/writes (verified)

| Flow | Reads | Writes | State location | Daemon needed? | Source |
|---|---|---|---|---|---|
| **Scribe doc-sync** | git diff, engineer summaries, CLAUDE.md/context.md/CONVENTIONS.md | `docs(context-sync):` commit; `.canon/last-scribe-commit` | git tree (commit) **+** `.canon/last-scribe-commit` (gitignored marker) | **No** for the doc edit; uses `get_file_context`/`graph_query` only as *enrichment* | `agents/scribe.md` tools list; `hooks/canon-agent-teams/session-start-doc-check.sh:21,47` |
| **Doc-staleness nudge** (today) | HEAD vs `.canon/last-scribe-commit` | stdout note only | reads gitignored marker | No | `session-start-doc-check.sh:33,47` (`git rev-list --count`) |
| **KG-staleness nudge** (today) | mtime of `.canon/knowledge-graph.db` | stdout note only | gitignored 20MB SQLite | No (but the *refresh* it suggests needs `codebase_graph`) | `session-start-kg-check.sh:20,45` |
| **Learner sweep** | `.canon/drift.db`, `.canon/reviews.jsonl`, `.canon/learning.jsonl`, KG via `graph_query`/`get_drift_report` | `.canon/LEARNING-REPORT.md`, `.canon/learning.jsonl`, `.canon/proposed-learnings/` | **entirely `.canon/`** (all gitignored) | **Yes** — `get_drift_report`, `graph_query`, `semantic_search`, `computeWatchConfidence` | `agents/learner.md` tools + write scope |
| **Drift sweep + auto-resolve** | `.canon/drift.db` (1MB SQLite + WAL) | drift store mutations | **`.canon/drift.db`** (gitignored) | **Yes** — drift tools are MCP daemon | `.canon/drift.db`, `.canon/drift.db-wal` verified present |
| **Janitor prune** | `git worktree list`, `.canon/worktrees/`, `.canon/workspaces/` | deletes paths under `.canon/worktrees/` + `.canon/workspaces/` | **local worktrees/workspaces** (gitignored, machine-specific) | `invoke_janitor` MCP signal, but the prune itself is `git worktree`+`rm` | `agents/janitor.md:4-8,33,49-55` |
| **Release-ahead check** | `git rev-list --count origin/main..HEAD`, tags | notification only | none (pure git) | **No** | CLAUDE.md Completion-Checklist push-state check; `project_release_bump_lockfile_gap` (sug_EEEE2) |
| **Autonomous PR review** | PR diff via `gh`/git, principles | `gh pr comment`, `.canon/reviews.jsonl` (only in `--incremental`) | principles are bundled; `--incremental` reads gitignored `.canon/reviews.jsonl` | **Partial** — `get_principles` is daemon; falls back to globbing `${CLAUDE_PLUGIN_ROOT}/principles/**` | `skills/canon/commands/pr-review.md:26` (`getLastReviewForPr` reads `.canon/reviews.jsonl`) |

### 0.3 The two load-bearing Canon-side facts

1. **The gitignore collision is real and total.** `.gitignore:28` ignores `**/.canon/**`. A
   cloud routine clones the default branch and has *zero* `.canon/` — no `drift.db`, no
   `knowledge-graph.db` (20MB), no `learning.jsonl`, no `reviews.jsonl`, no worktrees, no
   workspaces. Every flow whose value depends on that state is **structurally impossible** as a
   cloud routine without first solving "how does `.canon/` state reach the cloud," which is a
   separate epic Canon has not committed to.
2. **The daemon-boot headless feasibility is unproven.** The HTTP-transport epic shipped a
   flag-dark daemon (`project_http_epic_phase2_shipped`) but the boot path has a documented
   fragility history (circular node_modules symlink, npx tsx zero-tool cold start —
   `project_mcp_boot_root_cause_pinned`). Until `canon-probe`'s A3-headless check is green
   (SYNTHESIS row 17 precondition), **no cloud routine may depend on the MCP daemon.** This
   leaves only daemon-free flows (plain prompt + git + `gh`) as cloud-eligible *today*.

**The combined gate for cloud-routine eligibility:** a flow is a cloud-routine candidate ONLY
if (a) it reads/writes **git-native** state (commits, PRs, tags, diffs — not `.canon/`), AND
(b) it needs **no MCP daemon** (or degrades to the principle-glob fallback). Everything else is
desktop-task-only or not-schedulable-durably.

---

## 1. The mechanism-fit reasoning (why each lane exists)

- **Cloud routine** is the *only* lane that runs when the machine is off, but it pays for that
  with a stateless fresh clone and no interactive auth. It fits **git-native, daemon-free,
  guardrailed-write** jobs whose entire input is the repo and whose entire output is a commit/PR.
- **Desktop task** is the lane for jobs that **need local state** — `.canon/` SQLite, worktrees,
  the live KG. It is the closest thing to "bundling" (pre-populated SKILL.md) but requires the
  app running and a manual schedule attach.
- **GitHub Action** is a *third* bundling vehicle the brief folds under "recipe": fully
  committable (`.github/workflows/*.yml` — this repo already ships `ci.yml`, `pr-title.yml`,
  `release-please.yml`), runs on GitHub's runners, is repo-state-native, and is the natural home
  for **event-triggered, repo-only** jobs (PR-opened review, push-time release-ahead check). It
  is strictly more bundleable than a cloud routine and needs no claude.ai account resource.

---

## 2. Decision matrix — candidate background flows

Columns: **best mechanism** · **state needs** · **daemon?** · **guardrails** · **relationship
to Inc-6 `canon-maintenance`**.

| Flow | Best mechanism | State needs | Daemon? | Guardrails | vs Inc-6 canon-maintenance |
|---|---|---|---|---|---|
| **Scribe doc-sync** | **Desktop task** (primary) · cloud-routine *possible but degraded* | reads git diff (✓cloud) but the `last-scribe-commit` marker is gitignored → cloud can't tell *when* it last ran | No for the edit | draft-PR + notify, never silent push to main | **IS the canonical canon-maintenance member** — scribe is named explicitly in SYNTHESIS row 17 ("scribe/janitor/re-index"). This flow = Inc-6's first concern. |
| **Learner sweep** | **Desktop task ONLY** (or not-schedulable durably) | **all `.canon/`** (drift.db, reviews.jsonl, learning.jsonl) — *invisible to cloud clone* | **Yes** (get_drift_report, graph_query) | output is `.canon/` proposals — read-only to repo, zero push risk | Adjacent to Inc-6 but distinct: SYNTHESIS wires learner mining via `canon-learn-mine` (Inc 5, every-build step), **not** the maintenance cron. A *scheduled* learner sweep is a NEW idea this doc adds. |
| **Drift sweep + auto-resolve** | **Desktop task** for sweep; **not-schedulable** for auto-resolve | `.canon/drift.db` (gitignored SQLite+WAL) | **Yes** | auto-*resolve* mutates code → must be draft-PR + notify; sweep alone is read-only | Fits Inc-6 "re-index" lane conceptually, but drift state is local → cannot be a cloud routine. Desktop-task member of maintenance. |
| **Janitor prune** | **Desktop task ONLY** | `.canon/worktrees/`, `.canon/workspaces/` — *machine-specific, absent in cloud clone* | `invoke_janitor` signal (daemon) | deletes only under `.canon/worktrees`+`.canon/workspaces` (already enforced `agents/janitor.md:33`) | **Confirmed: explicitly named in SYNTHESIS row 17.** Inherently local → **desktop-task realization of canon-maintenance's janitor concern. Cloud is impossible** (no worktrees to prune in a fresh clone). |
| **Release-ahead check** | **GitHub Action** (primary) · cloud routine (fine) · desktop (fine) | **pure git** (rev-list, tags) — fully cloud-safe | **No** | notification only; zero mutation | New lightweight job; not in SYNTHESIS. Could be a maintenance concern but is so cheap + stateless it's better as a standalone Action. Targets `sug_EEEE2`. |
| **Autonomous PR review** | **GitHub Action** (primary) · cloud routine (GitHub-trigger) | PR diff (✓cloud); principles bundled (✓); `--incremental` needs `.canon/reviews.jsonl` (✗cloud) | **Partial** — falls back to `${CLAUDE_PLUGIN_ROOT}/principles/**` glob (`pr-review.md` fallback) | post comment only, never merge/approve | Distinct lane — *event-triggered review*, not scheduled hygiene. NOT canon-maintenance. Closest existing wire: `/canon:pr-review`. |

### 2.1 Matrix verdicts (one line each)

- **Janitor → desktop-task ONLY.** Cloud clone has no worktrees. **Not a cloud candidate, full stop.**
- **Learner sweep → desktop-task ONLY.** All inputs/outputs are gitignored `.canon/` + needs daemon.
- **Drift sweep → desktop-task** (read-only); **auto-resolve → not-durably-schedulable** until it can draft-PR safely.
- **Scribe doc-sync → desktop-task primary**; cloud-degraded (loses the "since last scribe" marker).
- **Release-ahead check → GitHub Action.** Cheapest, fully stateless, daemon-free, repo-native. **Top cloud/Action candidate.**
- **Autonomous PR review → GitHub Action.** Stateless if `--incremental` is dropped; principle-glob fallback removes the daemon dependency. **Second cloud/Action candidate.**

**The headline finding:** of six candidates, **only two (release-ahead, PR review) are durable-
cloud/Action-eligible** — precisely the two that are git-native and daemon-free. The four most
"Canon-ish" hygiene flows (scribe, learner, drift, janitor) are all **`.canon`-bound and/or
daemon-bound → desktop-task at best**, which is exactly the lane SYNTHESIS already reserved for
`canon-maintenance`.

---

## 3. The bundling story (how Canon ships each job)

Three concrete vehicles, mapped to the matrix:

### 3.1 GitHub Action — for release-ahead + PR review (fully bundleable, recommended first)

These ship as committed `.yml` — the *only* lane that is genuinely "in the plugin/repo" with no
account resource and no manual attach. The repo already proves the pattern (`.github/workflows/ci.yml`).

**Proposed new surface area (top recommendation #1):**

| Artifact | Path | What it is |
|---|---|---|
| Release-ahead Action | `.github/workflows/canon-release-ahead.yml` | On `push` to main (or nightly `schedule:`), runs `git rev-list --count $(git describe --tags --abbrev=0)..HEAD`; if > 0, opens/updates a tracking issue "main is N commits ahead of last tag vX.Y.Z". Pure shell, no Claude, no daemon. Directly closes `sug_EEEE2`. |
| Recipe doc | `docs/reference/scheduled-jobs.md` | Human-facing catalog: what each shippable job does, which mechanism, how to enable. (New file — there is no existing scheduled-jobs reference.) |

**Proposed new surface area (top recommendation #2):**

| Artifact | Path | What it is |
|---|---|---|
| Autonomous PR-review Action | `.github/workflows/canon-pr-review.yml` | On `pull_request` opened/synchronize, runs `claude -p` with the Canon reviewer prompt against the PR diff, principles loaded via the `${CLAUDE_PLUGIN_ROOT}/principles/**` glob fallback (`pr-review.md` already specifies this fallback), posts a single review comment. **No daemon, no `.canon/` state, full-review mode only** (drop `--incremental` — it needs gitignored `reviews.jsonl`). Mirrors `/canon:pr-review` minus the local-state half. |

### 3.2 Desktop scheduled task — for scribe / janitor / drift-sweep / learner (pre-populated SKILL.md)

The plugin pre-populates `~/.claude/scheduled-tasks/<name>/SKILL.md`; the user attaches the
schedule manually. This is the only durable lane with `.canon/` + worktree + daemon access, so
it is the home for the four local-state flows.

**Proposed surface area (the canon-maintenance realization — see §4):**

| Artifact | Path | What it is |
|---|---|---|
| Maintenance task template | `templates/scheduled-tasks/canon-maintenance/SKILL.md` | The pre-populated desktop-task body. Runs scribe doc-sync → janitor prune → (optional) drift sweep, **draft-PR + notify, never silent merge** (SYNTHESIS guardrail verbatim). Ships in the plugin; the recipe doc tells the user to copy it to `~/.claude/scheduled-tasks/` and attach a schedule. |
| Install hint | (one line in `docs/reference/scheduled-jobs.md`) | "Copy `templates/scheduled-tasks/canon-maintenance/` to `~/.claude/scheduled-tasks/` and attach a daily schedule in the desktop app." |

> **Why not auto-install the desktop SKILL.md at plugin init?** Because attaching a *schedule*
> is still manual and silently pre-populating a scheduled-task directory the user didn't ask for
> is surprising. Ship it as a template + a one-command recipe, not an auto-install. (Open Q3.)

### 3.3 Cloud routine — recipe only, deferred

Cloud routines **cannot be bundled** (no manifest field, account resource). The only honest
delivery is a *recipe* in `docs/reference/scheduled-jobs.md`: "to run the release-ahead or
PR-review job in the cloud when your machine is off, create a `/schedule` routine with this
prompt + these triggers." Since the same two jobs are better served by GitHub Actions (committed,
no account dependency), **the cloud-routine recipe is a documented fallback, not a primary
recommendation.** No new file beyond the recipe doc.

---

## 4. Relationship to Inc-6 `canon-maintenance` and the `/loop` designs

### 4.1 vs Inc-6 `canon-maintenance` (Ratified) — routines-integration is the DELIVERY VEHICLE, not a competitor

SYNTHESIS §4d / §5 row 17 / §8 Q4 already **decided** `canon-maintenance`: a CronCreate-scheduled
maintenance flow (scribe/janitor/re-index), "draft-PR + notify, never silent merge," gated behind
headless-MCP probe green. My exploration **slots underneath that decision** and clarifies its
realization:

| Question | This doc's answer |
|---|---|
| Is routines-integration a superset of canon-maintenance? | **No — it is the delivery-mechanism layer.** canon-maintenance is *what* runs (scribe/janitor hygiene); routines-integration is *which scheduler carries it.* |
| Which mechanism realizes canon-maintenance? | **Desktop scheduled task, NOT cloud routine.** SYNTHESIS says "CronCreate" but its members (janitor, scribe-marker, drift) are all `.canon`/worktree/daemon-bound (§2). A *cloud* canon-maintenance is structurally impossible (no worktrees to prune, no `.canon/` to read) until the state-collision + headless-daemon epics land. The honest realization is a **pre-populated desktop-task SKILL.md** (§3.2). |
| Does this contradict the ratified design? | **No — it refines "CronCreate" to "desktop scheduled task" and confirms the guardrail.** SYNTHESIS's own headless-MCP precondition (row 17) is exactly the §0.3 fact #2 constraint; this doc explains *why* that precondition is binding and what to do until it clears (use desktop, not cloud). |
| What does routines-integration ADD beyond canon-maintenance? | **Two genuinely new git-native jobs** (release-ahead Action, autonomous PR-review Action) that are NOT hygiene-cron members and belong in a different lane (GitHub Actions), plus a **scheduled learner sweep** idea distinct from the every-build `canon-learn-mine` (Inc 5). |

**Recommendation: treat routines-integration as the scheduler-selection + bundling layer for the
already-ratified canon-maintenance, and realize canon-maintenance as a desktop scheduled task
(not a cloud routine) until the headless-daemon + state-collision preconditions clear.** The two
new Action jobs are a sibling track, not part of canon-maintenance.

### 4.2 vs the `/loop` designs (session-local cousin) — siblings on a state-durability axis

`loop-integration/DESIGN.md` covers session-cron `/loop`: ship-watch and reconcile-poll, both
**session-local, die on session exit.** This doc covers the **durable** lane. They are siblings:

| Axis | `/loop` (session cron) | routines (cloud / desktop) |
|---|---|---|
| Lifetime | dies with the session | survives machine off (cloud) / app restart (desktop) |
| State | full local | cloud=none, desktop=full local |
| Best for | *attended* waiting (watch this ship resolve) | *unattended* recurring hygiene + event-triggered review |
| Overlap | ship-watch watches one PR's CI | autonomous-PR-review reviews every PR repo-wide |

**The clean division:** `/loop` ship-watch is *attended, one-build, self-terminating*; the
cloud/Action PR-review is *unattended, repo-wide, standing* — exactly the boundary
`loop-integration` §1.4 already drew between ship-watch and `canon-maintenance`. This doc inherits
that boundary verbatim: **if you want "watch every PR forever," that's an Action/cloud job here,
NOT a `/loop`.**

### 4.3 vs Adaptive Queen (Parked) — respected, not reopened

The Adaptive Queen was parked because a standing monitor that *reconfigures a running swarm*
fights determinism (`adaptive-queen.md` §2). **None of the durable jobs here reconfigure a running
build** — they run *between* builds (hygiene) or on *external events* (PR opened). The determinism
boundary is not touched: a release-ahead Action or a scheduled janitor observes repo/local state
and notifies/drafts; it never mutates an in-flight build's path. No conflict.

---

## 5. Ranked recommendation

**Do the two git-native Actions first; realize canon-maintenance as a desktop task second; defer
everything cloud-daemon-bound until the preconditions clear.**

| Rank | Job | Mechanism | Effort | Why first | Targets |
|---|---|---|---|---|---|
| **1** | **Release-ahead check** | GitHub Action (`canon-release-ahead.yml`) + recipe doc | **XS** (~1 yml + 1 doc) | Pure shell, zero daemon, zero `.canon/`, zero mutation, zero new auth surface. Fully bundleable (committed). Closes a documented gap (`sug_EEEE2`). The smallest possible real win and the proof that the Action lane works. | release-bump lockfile gap |
| **2** | **Autonomous PR review** | GitHub Action (`canon-pr-review.yml`) + recipe doc | **S** (~1 yml + reuse reviewer prompt + principle-glob fallback) | Git-native, daemon-free via the existing `${CLAUDE_PLUGIN_ROOT}/principles/**` fallback, post-comment-only guardrail. Highest *user-visible* leverage. Sequenced second so the Action lane is proven by #1 first. | review coverage on PRs; `watch_AAAAA1` (stale-after-merge — runs on synchronize) |
| **3** | **canon-maintenance as desktop task** | Pre-populated `templates/scheduled-tasks/canon-maintenance/SKILL.md` (scribe + janitor + optional drift sweep) | **M** | This is the **ratified** Inc-6 item; this doc only resolves its *mechanism* (desktop, not cloud) and *bundling* (template SKILL.md). Effort is M because of the draft-PR + notify guardrail plumbing and the manual-schedule-attach UX. Gated by the same headless-MCP precondition SYNTHESIS already states for the daemon-using parts (learner/drift); the scribe+janitor parts can ship without it. | Inc-6; scribe/janitor hygiene |

**Explicitly deferred (NOT recommended now):**
- **Scheduled learner sweep** — needs daemon + all-`.canon/` state; only realizable as a desktop
  task, and `canon-learn-mine` (Inc 5) already covers the every-build path. Park until there's
  evidence a *scheduled* (vs per-build) sweep adds value.
- **Drift auto-resolve** — mutating code unattended is the highest-risk job; defer until it can
  reliably draft-PR-and-notify, and until headless daemon boot is proven.
- **Any cloud routine** — until the `.canon/` state-collision epic and headless-daemon probe both
  land, cloud routines can only do what the Actions already do better (committed, no account
  resource). The cloud recipe stays documentation-only.

**Sequence:** Build 1 = release-ahead Action (XS, independent). Build 2 = PR-review Action (S,
after #1 proves the lane). Build 3 = canon-maintenance desktop-task template (M, realizes the
ratified Inc-6 item). Do not bundle 1+2 — different triggers, and #1's trivial blast radius
should not be mixed with #2's `claude -p` + comment-posting surface.

---

## 6. Open questions (HAS_QUESTIONS)

**Q1 — Default scheduling posture: cloud-vs-desktop-vs-Action default.** My matrix says the only
*durable-eligible* jobs (release-ahead, PR-review) are best as **GitHub Actions** (committed, no
account resource, no daemon), and the `.canon`-bound hygiene jobs must be **desktop tasks**. Does
the user agree that **GitHub Actions are the default durable lane** and cloud routines are a
documented fallback only — given the cloud lane buys "runs when machine off" at the cost of the
gitignore collision (`.gitignore:28`) and unproven headless daemon boot (`project_mcp_boot_*`)?
**My lean:** Actions-first, cloud-as-recipe-fallback, desktop for local-state hygiene.

**Q2 — Consent model for autonomous repo writes.** SYNTHESIS guardrails canon-maintenance as
"draft-PR + notify, never silent merge." Should *every* durable job that touches the repo
(release-ahead opening an issue, PR-review posting a comment, maintenance drafting a PR) inherit
that exact guardrail — notify/draft only, never merge/approve/push-to-main? **My lean:** yes,
uniformly — the autonomous PR-review Action posts a *comment* (never an approving review), the
release Action opens an *issue* (never a tag/release — release-please owns that, per CLAUDE.md
Ship step), and maintenance drafts a PR. No durable job ever merges.

**Q3 — Fold the two new Actions into canon-maintenance, or keep them a sibling track?** §4.1
argues release-ahead + PR-review are git-native event/Action jobs, *not* hygiene-cron members, so
they belong in a sibling GitHub-Actions track rather than inside the desktop `canon-maintenance`
task. The alternative is one umbrella "canon-maintenance" covering both lanes. **My lean:** keep
them separate — the Action lane and the desktop-hygiene lane have different triggers (event vs
schedule), different state needs (none vs `.canon/`), and different bundling (committed `.yml` vs
template SKILL.md). One umbrella would force-fit two genuinely different mechanisms.

**Q4 — Auto-install the desktop SKILL.md at plugin init, or template + manual copy?** A plugin
*can* pre-populate `~/.claude/scheduled-tasks/canon-maintenance/SKILL.md`, but the schedule attach
is still manual and silently creating a scheduled-task directory is surprising. **My lean:** ship
as a `templates/scheduled-tasks/` template + a one-line recipe in `docs/reference/scheduled-jobs.md`,
not an auto-install — consistent with Canon's "no surprise side-effects" posture and with the
"recipe, not routine" bundling reality.

**Q5 (feasibility, not preference) — `claude -p` + `gh` availability on the GitHub runner.** The
PR-review Action assumes `claude -p` and `gh` work in CI with an `ANTHROPIC_API_KEY` secret and
the default `GITHUB_TOKEN`. Not blocking (the Action degrades to "review unavailable" and exits 0),
but worth a one-line confirmation the user is willing to provision the API-key secret before #2 is
committed. The release-ahead Action (#1) needs neither — pure shell + `GITHUB_TOKEN`.

---

### Status

DONE (exploration — design record written, not a committed build).

**Artifact:** `docs/explore/routines-integration/DESIGN.md`

**Summary:** Of six candidate background flows, **only two are durable-schedulable in the
cloud/Action lane** — release-ahead check and autonomous PR review — precisely because they are
**git-native and daemon-free**. The four most Canon-ish hygiene flows (scribe, learner, drift,
janitor) are all bound to gitignored `.canon/` state (`.gitignore:28` ignores `**/.canon/**`)
and/or the MCP daemon whose headless boot is unproven (`project_mcp_boot_*`), so they are
**desktop-task-only** — which is exactly the lane the ratified Inc-6 `canon-maintenance` already
reserves. **Bundling reality:** cloud routines can't be bundled (account resources); ship recipes
instead — GitHub Actions (`.github/workflows/canon-release-ahead.yml`, `canon-pr-review.yml`) for
the git-native jobs (fully committable, the repo already ships 3 workflows), and a pre-populated
desktop `templates/scheduled-tasks/canon-maintenance/SKILL.md` for the local-state hygiene jobs,
all catalogued in a new `docs/reference/scheduled-jobs.md`. **Relationship to Inc-6:**
routines-integration is the **delivery/scheduler-selection layer** for the already-ratified
canon-maintenance, and refines "CronCreate" to "desktop scheduled task" (cloud is structurally
impossible until the state-collision + headless-daemon epics land) — a refinement, not a
contradiction. **Relationship to `/loop`:** sibling on the durability axis — `/loop` is attended
and session-local, routines are unattended and durable; the ship-watch-vs-canon-maintenance
boundary from loop-integration §1.4 is inherited verbatim. **Adaptive Queen** boundary respected
— no durable job reconfigures a running build. **Top recommendation:** ship the release-ahead
GitHub Action first (XS, pure shell, closes `sug_EEEE2`), then the PR-review Action (S), then
realize canon-maintenance as a desktop-task template (M). Five open questions for the user
(Actions-vs-cloud default posture, uniform notify/draft-never-merge consent model, sibling-vs-
umbrella structure, auto-install-vs-recipe, and the `claude -p`/`gh` CI-secret feasibility).
