# Exploration: What Canon can learn from Matt Pocock's `grill-with-docs` + `setup-matt-pocock-skills`

> Status: open / decision-support. Source: user-requested grounded comparison of two
> external Claude-Code skills against Canon's actual surfaces, 2026-06-09. Not a build —
> no runbook, no DAG. The user will decide what (if anything) becomes a build.

## Thesis

Both skills encode one discipline Canon already shares — *read the code before asking,
ground questions in real artifacts* — and Canon implements it as well or better in the
refine skill and architect. The genuinely transferable ideas are narrower and more
specific than "do design conversations well": (1) **CONTEXT.md has no enforced glossary
discipline** and no terminology-conflict detector, so it will silently drift from
glossary-only into a spec scratchpad — `grill-with-docs`'s live-validate-on-conflict rule
targets exactly this gap; (2) **Canon's design decisions are ephemeral** — they live in
the gitignored workspace and never reach git history, so the "durable why" that an ADR
captures is *structurally absent* from Canon despite the machinery looking complete. The
3-condition ADR test is the one idea worth importing wholesale. Almost everything else is
either covered or a deliberate divergence Canon should keep. The setup skill's
triage-label/issue-tracker vocabulary is out of scope: Canon is a build-orchestration
plugin, not an issue-driven agent, and its intake is the PM refine conversation, not a
label taxonomy.

## Lesson-by-lesson map

| Lesson (from the two skills) | Canon's current mechanism | Verdict | Recommendation |
|---|---|---|---|
| **Explore codebase FIRST, before asking the user anything** | `refine/SKILL.md` §2.1 "Investigate" (MCP triage before stress-test) + §5 Red Flag "Asking the user questions you could answer by investigating the codebase"; architect Step 1 reads code + graph before Step 1a conversation | **covered** | None. Canon states this as an explicit red flag. If anything Canon is stricter (KG-grounded, not just file reads). |
| **One question per turn, wait for the answer before advancing** | Architect Step 1a uses `EnterPlanMode` (think-out-loud, not one-at-a-time); refine §4 explicitly *rejects* numbered checklists in favor of natural conversation; user's standing preference: surface design questions via **AskUserQuestion** | **divergence** | Keep Canon's batched/conversational model. See divergences §1. Sequential-blocking interrogation fights Canon's silent-dispatch + low-message-count constraint. |
| **ALWAYS offer a recommended answer, don't just ask** | refine §4 "State a lean"; architect Step 1a "State a lean and invite correction"; Step 4 surfaces assumptions with a lean | **covered** | None — this is already Canon doctrine ("PM has opinions and uses them"). |
| **CONTEXT.md is glossary-ONLY — no specs, no implementation detail** | CONTEXT.md header declares glossary-only and points specs to CONVENTIONS.md/CLAUDE.md; scribe Step 6 restricts CONTEXT.md edits to named domain-concept intro/rename/remove | **gap (enforcement)** | The *rule* exists in prose; *nothing enforces it*. wiki_lint has no glossary-discipline check. See gap §1. |
| **Validate user terminology against the glossary; interrupt on conflict** | No mechanism. scribe Step 5c DDD scan detects *factual rot* (renamed/dead cited paths, stale type lists) — NOT terminology conflicts. wiki_lint checks contradictions/orphans/stale-refs/scope-tags in *principles*, never CONTEXT.md terms vs build vocabulary | **gap** | Real gap. A build can introduce a term colliding with a CONTEXT.md definition and nothing flags it. See gap §2. |
| **Update docs LIVE as each term resolves, not batched** | Canon batches ALL doc updates into the end-of-build scribe context-sync step | **divergence (mostly)** | Keep end-of-build sync for CLAUDE.md/CONVENTIONS.md. But there's a narrow case for the glossary. See divergences §2 + gap §2. |
| **ADR ONLY when all 3 hold: hard-to-reverse AND surprising-without-context AND a genuine trade-off** | architect `design-decision.md` template requires ≥2 options + "Revisit If" trigger — but has **no creation-gate test** (any "non-obvious decision" qualifies) | **gap** | Import the 3-condition gate into the decision template's Rules. See gap §3. |
| **ADRs are durable, lazily-created, version-controlled (`docs/adr/`)** | Decision docs write to `${WORKSPACE}/decisions/` → `**/.canon/**` is **gitignored** → decisions never reach git history. They are consumed by engineers in-build, then vanish | **gap (the big one)** | Canon has the *form* of ADRs but not the *durability*. The "why" evaporates at workspace cleanup. See gap §4 — this is the highest-value finding. |
| **Cross-check stated behavior vs actual code; surface contradictions** | architect Step 2a empirical candidate comparison + reviewer functional verification; refine grounds in graph data | **covered** | None. Canon's review/verify layer does this at code level. |
| **Build shared canonical language incrementally; disambiguate overloaded words** | CONTEXT.md exists (21 terms) and is the stated authority; no incremental proposal mechanism beyond scribe's reactive sync | **partial** | Low priority. The glossary exists; the missing piece is the conflict-detector (gap §2), not an incremental-proposal flow. |
| **setup skill: canonical triage-label vocabulary (needs-triage, ready-for-agent…)** | None. Canon has no issue-tracker integration, no label taxonomy. Intake = PM refine conversation + intent classification | **divergence (out of scope)** | Do NOT adopt. See divergences §3. Canon is invoked conversationally, not dispatched from labeled issues. |
| **setup skill: one-time idempotent scaffolder writing `## Agent skills` into CLAUDE.md** | Canon ships its CLAUDE.md/agents/skills as the product; `/canon:init` bootstraps a target repo | **covered (different shape)** | None. Canon's whole install IS this, at far greater scope. The idempotent update-in-place discipline is already a scribe concern (post-scribe scope guard). |
| **Never create both CLAUDE.md and AGENTS.md; update-in-place, never duplicate** | scribe post-scribe scope guard + doc-trim-fact-preservation convention guard against over-trim/duplication | **covered** | None. |

## Highest-value gaps (with build sketches)

### Gap 4 (top priority) — Design decisions are ephemeral; the durable "why" is structurally absent

**Finding.** `git log --all --diff-filter=A -- '**/decisions/*.md'` returns nothing.
`.gitignore` line 32 (`**/.canon/**`) covers `.canon/workspaces/**`, and the architect
writes decision docs to `${WORKSPACE}/decisions/`. So every design decision Canon records
is consumed by engineers during the build and then **deleted with the workspace**. Six
months later, the only durable record of *why* a build chose option A over option B is:
(a) the PR description, (b) a `docs/explore/` brief if someone wrote one, or (c) learner
suggestions. None of these is the structured, greppable, per-decision ADR the template
already produces — that artifact exists for ~one build's lifetime and dies.

This is the sharpest divergence from `grill-with-docs`: Canon has the *richer* decision
template (≥2 options, Canon-principle alignment, Revisit-If trigger) but throws it away,
while Pocock's simpler ADR persists in `docs/adr/`.

**What a build would change (files, not code):**
- `agents/architect.md` Step 5/Step 366: add a *promotion* rule — when a decision meets
  the 3-condition ADR test (gap 3), the architect also writes a durable copy to a new
  tracked `docs/adr/NNN-{slug}.md` (lazily created, like `grill-with-docs`), not only the
  ephemeral workspace copy. Workspace copy stays for in-build engineer consumption; the
  durable copy is the long-term record.
- `templates/design-decision.md`: add an `### ADR Promotion` note distinguishing
  ephemeral (every decision) from durable (3-condition-passing decisions).
- `docs/.claude/CLAUDE.md` + `docs/explore/CLAUDE.md`: clarify the boundary — explore
  briefs are *exploratory reasoning* (often pre-build, parked/open), ADRs are
  *ratified single-decision records* tied to a shipped build. They are not the same
  artifact (see "explore brief vs ADR" below).
- Optional: a `wiki_lint` check that flags an ADR whose `status: accepted` cites a
  file path that no longer exists (reuses the existing `checkCitedPaths` machinery).

**Explore brief vs ADR — the difference that matters.** A `docs/explore/` brief is a
*reasoning artifact*: it captures a design space, often before a decision, frequently
parked or open, and reads as narrative (see `adaptive-queen.md`). An ADR is a *commitment
record*: one decision, ratified, tied to a shipped diff, structured for grep + revisit.
Canon currently has the former (durable) and the latter (ephemeral) — exactly backwards
from where durability matters most. The "why we parked X" is preserved; the "why we
*shipped* X this specific way" is not.

### Gap 2 — No terminology-conflict detection against CONTEXT.md

**Finding.** Nothing in Canon flags when a build introduces a term that collides with an
existing CONTEXT.md definition. scribe Step 5c detects *factual rot* (dead cited paths,
stale type lists) but never compares build vocabulary to glossary definitions. wiki_lint's
five checks (`checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`,
`checkCitedPaths`, `checkScopeTags/Layers`) all operate on *principles*, not on CONTEXT.md
terms. A build can redefine "Flow" or overload "Tier" (note: CONTEXT.md already carries
*two* "Tier" entries — Autonomy Tier and Build Tier — exactly the overloading
`grill-with-docs` warns about) and nothing interrupts.

**What a build would change:**
- `mcp-server/src/features/diagnostics/services/wiki-lint.ts`: add a
  `checkGlossaryConflicts` function — parse CONTEXT.md `## Term` headings, then scan the
  build diff (or new principle/agent text) for the same term used with a divergent
  one-line gloss. This is heuristic, not semantic; scope it to *new defined terms* in the
  diff that shadow an existing heading.
- `mcp-server/src/features/diagnostics/tools/wiki-lint.ts`: surface the new finding class.
- `agents/scribe.md` Step 6: when the conflict check fires, require the scribe to either
  reconcile the term or record `no-conflict (intentional overload — disambiguated)` —
  mirroring the existing Step 5c no-drift disposition discipline.

This is the single most faithful import of `grill-with-docs`'s "interrupt immediately on
glossary conflict" rule, adapted to Canon's batched-enforcement model (it fires at
context-sync, not mid-conversation — see divergence §2).

### Gap 3 — The ADR creation-gate test is missing

**Finding.** `templates/design-decision.md` Rules say "include at least 2 options — if the
choice was obvious, you don't need a decision doc." That's a *weak* gate. `grill-with-docs`
uses a *strong* 3-condition gate: hard-to-reverse AND surprising-without-context AND a
genuine trade-off. Canon's weak gate produces decision docs for any non-obvious choice,
inflating ephemeral noise (which is then thrown away anyway, per gap 4).

**What a build would change:**
- `templates/design-decision.md` Rules: replace the "2 options" gate with the
  3-condition test. This *also* becomes the promotion gate for gap 4 (only
  3-condition-passing decisions get a durable `docs/adr/` copy).
- `agents/architect.md` Step 4: reference the gate so the architect stops emitting a
  decision doc for every fork.

Gap 3 + Gap 4 are naturally **one build**: the 3-condition test is the filter that decides
which ephemeral decisions earn durable ADR promotion. Ship them together.

### Gap 1 — CONTEXT.md glossary-only discipline is unenforced

**Finding.** The glossary-only rule lives only in CONTEXT.md's own header prose and in
scribe Step 6's restraint instructions. Nothing detects when CONTEXT.md drifts into specs
(e.g., an entry that grows implementation detail, a how-to paragraph, or a scratch note).
Today CONTEXT.md is clean — but it's clean by scribe discipline, not by enforcement, and
the scribe is the agent most likely to over-write it.

**What a build would change:**
- `mcp-server/src/features/diagnostics/services/wiki-lint.ts`: a lightweight
  `checkGlossaryShape` — flag CONTEXT.md entries that exceed N sentences, contain code
  fences, or contain imperative how-to phrasing ("run", "call", "set"). Heuristic and
  advisory, like the other wiki_lint checks.

Lower priority than gaps 2–4: it's a latent risk, not an active defect. Bundle it with
gap 2 if a glossary-quality build happens, since both touch the same file and service.

## Deliberate divergences — what Canon should NOT copy

### Divergence 1 — Sequential one-question-per-turn interrogation

`grill-with-docs` interviews strictly sequentially: one question, wait, advance. Canon
should **not** adopt this. Three reasons: (a) it directly fights the **silent-dispatch /
~100-message TTL constraint** in CLAUDE.md — a long sequential interrogation balloons
message count into the `cache_control` ordering bug; (b) the user's standing preference is
to surface design questions via **AskUserQuestion** (batched, structured), not a turn-by-turn
drip; (c) refine §5 already names "producing a numbered checklist instead of a natural
conversation" as a red flag. Canon's think-out-loud `EnterPlanMode` + batched
AskUserQuestion is the better fit for an orchestration loop that must stay terse. Keep it.

### Divergence 2 — Live, immediate doc updates during the conversation

`grill-with-docs` updates CONTEXT.md *live*, as each term resolves. Canon batches doc
updates into the end-of-build scribe step. **Keep batching** — with one nuance. The reason
batching is right for Canon: docs are updated on the **build branch in the worktree**, then
shipped atomically with the code, so the glossary never describes a term whose
implementation hasn't merged. Live mid-build glossary edits would create a window where
CONTEXT.md claims a term the code hasn't landed. The *one* thing worth borrowing is not the
timing but the **conflict-detection trigger** (gap 2): detect the collision at context-sync
(batched), don't edit the glossary mid-conversation (live). So: adopt the *interrupt-on-
conflict intent*, reject the *live-write timing*.

### Divergence 3 — Triage-label vocabulary + issue-tracker config

The entire `setup-matt-pocock-skills` premise — a repo where coding agents are dispatched
from labeled GitHub issues (`needs-triage`, `ready-for-agent`, `ready-for-human`) — does
not map to Canon. Canon is invoked **conversationally** through the PM, and its intake
"triage" is the refine skill's tier classification (trivial/clear/fuzzy) + intent
classification, not a label taxonomy on an issue tracker. Adopting a label vocabulary would
add a second, redundant intake model. Out of scope. The only transferable atom — *have a
canonical, small, closed vocabulary for a recurring classification* — Canon already
practices everywhere (verdict CLEAN/WARNING/BLOCKING; tier trivial/small/medium/large;
disposition covered/descoped/partial). Canon doesn't need another one.

## Bottom line for the user

If you turn anything into a build, make it **Gaps 3 + 4 together: the 3-condition ADR gate
+ durable `docs/adr/` promotion.** That fixes a real structural hole (Canon's design
rationale currently evaporates at workspace cleanup) and is small — it touches
`templates/design-decision.md`, `agents/architect.md`, and adds a `docs/adr/` directory,
with an optional wiki_lint stale-path check. **Gap 2 (terminology-conflict detection)** is
the second-most-valuable and is a clean, self-contained wiki_lint + scribe addition. Gap 1
is a nice-to-have to bundle with gap 2. Everything else is already covered or a divergence
worth keeping.
