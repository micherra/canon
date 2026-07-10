# Harness ↔ Canon Integration Audit — Claude Code 2.1.206

**Date:** 2026-07-10
**Auditor:** canon:architect (read-only investigation)
**Session harness version:** Claude Code 2.1.206
**Scope:** Every harness primitive Canon's docs/protocols reference or depend on, cross-checked against what harness 2.1.206 actually provides.
**Status:** Delta map only — no fixes designed. The reader picks what to build next.

---

## Method & evidence sources

- **Doc surface discovered empirically** by grepping `CLAUDE.md`, `references/*.md`, `docs/**/*.md`, `agents/*.md`, `skills/canon/**`, `hooks/`, `loops/`, `templates/`, `workflows/` for each primitive name.
- **Official harness behavior** verified via WebFetch of `https://code.claude.com/docs/en/agent-teams` (authoritative for the teams/task/messaging surface; explicitly version-stamped).
- **Live tool surface**: the initial audit ran as a subagent that could invoke only **LSP** directly (`documentSymbol` succeeded against a real `.ts` file). All other orchestrator-only primitives were routed to a probe list.
- **Orchestrator probe pass (2026-07-10, folded in):** the full-session orchestrator subsequently **invoked every routed primitive** against 2.1.206 and returned verified schemas. Those results are now incorporated below and supersede the earlier `unverified` verdicts. Live-verified call-shapes are marked **[orchestrator-probed]**. Per `agent-surface-assumptions`, every remaining claim is grounded in either a live invocation or version-stamped official docs — none is inferred from Canon's own docs (the thing under audit).

---

## Per-primitive delta inventory

### 1. Agent teams — `TeamCreate` / `TeamDelete`

- **What Canon assumes / documents:**
  - `references/dag-execution-protocol.md:22` — `TeamCreate({ team_name: "canon-{slug}" })` to open a team for DAG worker dispatch.
  - `references/dag-execution-protocol.md:45` — `TeamDelete({ team_name: "canon-{slug}" })` at cleanup.
  - `references/dag-execution-protocol.md:27,31` — "always use `TeamCreate`/`TaskCreate` for worker dispatch"; "If the orchestrator cannot call TeamCreate, it must HITL before proceeding."
  - `CLAUDE.md:201,206` — DAG stub pointer references `TeamCreate/TaskCreate` + `TeamCreate/merge/cleanup`.
  - `hooks/dag-dispatch-guard.sh:4-5,77-78` — **live PreToolUse hook** that WARNS on raw `Agent` spawns during DAG execution and instructs the orchestrator to "use TeamCreate/TaskCreate for worker dispatch instead."
  - Also referenced across the `docs/explore/workflow-integration/*` exploration set, `docs/supervised-build-quality.md:61`, `references/.claude/CLAUDE.md` inventory prose.
- **What harness 2.1.206 actually provides:** Both tools **no longer exist**. Official docs (agent-teams page, version note): *"This page describes agent teams as of v2.1.178. … Before v2.1.178, you asked Claude to create and name a team first, and Claude used the `TeamCreate` and `TeamDelete` tools. **Both tools no longer exist.** The `team_name` input on the Agent tool is accepted but ignored…"* Session is 2.1.206, well past the removal. There is now exactly **one implicit team per session**; teammates are spawned via `Agent({ name })` and coordinate through the shared task list + mailbox. Evidence: official docs (version-stamped).
- **Drift severity:** `stale-docs` **on a dormant path**, with a live-hook aggravator. The DAG parallel path is dormant by design (see §12) — `dag-execution-protocol.md:16` states the live path is single-worktree sequential and the wave-lifecycle helpers were removed in PR #167. So no live build actually calls `TeamCreate` today. BUT: (a) if the DAG path were re-activated as written it would dispatch to a non-existent tool → the `TeamCreate` invariant's own fallback ("cannot call TeamCreate → HITL") is now the **guaranteed** branch, making the protocol un-runnable as written; (b) `dag-dispatch-guard.sh` is a **currently-registered hook actively steering the orchestrator toward a dead tool** on any Agent spawn during a DAG step.
- **Recommended action:** (1) Rewrite `references/dag-execution-protocol.md` to the implicit-team model: replace `TeamCreate`/`TeamDelete` with "spawn teammates via `Agent({ name })` into the session's single implicit team; no create/delete step; cleanup is automatic on session exit." (2) Update or retire `hooks/dag-dispatch-guard.sh` — its warning text names a dead tool; at minimum change the remediation string, ideally re-express the guard in terms of the implicit-team dispatch pattern. (3) Scrub `CLAUDE.md:201,206`, `docs/supervised-build-quality.md:61`, and `references/.claude/CLAUDE.md` inventory prose. (4) `docs/explore/workflow-integration/*` are historical exploration docs — annotate as superseded rather than rewrite.
- **Blast radius:** `references/dag-execution-protocol.md`, `hooks/dag-dispatch-guard.sh`, `CLAUDE.md`, `docs/supervised-build-quality.md`, `references/.claude/CLAUDE.md`, `references/canon-orchestrator.md:110`, plus ~8 `docs/explore/workflow-integration/*` files (annotate-only).

### 2. Agent-teams availability guard (never-built TODO)

- **What Canon assumes / documents:** `dag-execution-protocol.md:31` — "If the orchestrator cannot call TeamCreate, it must HITL." Confirmed-drift-signal #3: an *availability guard* that degrades to sequential dispatch when teams tools aren't registered was proposed but never implemented; the interim fix was setting `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- **What harness 2.1.206 actually provides:** Teams are still **experimental and env-gated** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). With the flag unset, "no team is set up at session start … Claude does not spawn or propose teammates." The flag IS set in `~/.claude/settings.json`. The failure mode has shifted: it is no longer "TeamCreate not registered" (that tool is gone regardless) but "flag unset → `Agent({name})` teammates unavailable." Evidence: official docs.
- **Drift severity:** `stale-docs` (dormant path) — the guard's trigger condition ("cannot call TeamCreate") is obsolete because `TeamCreate` no longer exists in any configuration.
- **Recommended action:** If/when the DAG path is rebuilt, define the guard against the *real* 2.1.206 signal — env-flag presence and whether `Agent({name})` teammate spawns succeed — not `TeamCreate` registration. Until then, fold this into the §1 rewrite. Also note the several new **limitations** the guard should account for: no session resumption with in-process teammates, no nested teams (teammates cannot spawn teammates), one team per session.
- **Blast radius:** `references/dag-execution-protocol.md` (design-time only; no code today).

### 3. Task management tools — `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop`

- **What Canon assumes / documents:**
  - `references/dag-execution-protocol.md:23` — `TaskCreate({ title, description })`; `TaskUpdate({ addBlockedBy: [...] })`; `:57` `TaskCreate` retry.
  - `templates/worker-prompt.md:42,44,56,57,75` — `TaskList` to find unblocked/unclaimed tasks; `TaskUpdate({ task_id, owner, status: "in_progress" })`; `TaskUpdate({ task_id, status: "completed" })`; `TaskUpdate` failure marking.
  - `CLAUDE.md`, `docs/supervised-build-quality.md`, `docs/explore/workflow-integration/*`.
- **What harness 2.1.206 actually provides [orchestrator-probed]:** Task tools **still present**, with **confirmed call-shape drift**. Live: `TaskCreate({ subject, description, activeForm?, metadata? })` and `TaskUpdate({ taskId, status, owner, addBlockedBy, addBlocks, ... })`. Canon docs use `TaskCreate({ title })` (→ **`title` must become `subject`**) and `TaskUpdate({ task_id })` (→ **`task_id` must become `taskId`**). Canon's `owner`, `status`, and `addBlockedBy` params are **correct**. Evidence: live probe.
- **Drift severity:** `stale-docs` (confirmed) — real param-name drift, but on the **dormant** DAG path (§12), so low urgency.
- **Recommended action:** When the DAG path is next touched, apply the two renames in `templates/worker-prompt.md` (`task_id`→`taskId`, and any `title`→`subject` at task creation) and `dag-execution-protocol.md:23` (`TaskCreate({ title })`→`{ subject }`). Fold into the §1 implicit-team rewrite.
- **Blast radius:** `templates/worker-prompt.md`, `references/dag-execution-protocol.md`.

### 4. Teammate addressing — `Agent({ name })` + `SendMessage`

- **What Canon assumes / documents:** `CLAUDE.md:443` — Agent `name` MUST be session-unique (`{agent-type}-{step_id}-{job_suffix}`); "`SendMessage` routes by bare name; concurrent sessions sharing it cross mailboxes (watch_OOOOOOOOOO2)." `references/escalation-protocol.md:42` — SendMessage resume for stream-idle recovery. `.canon/principles/conventions/session-unique-agent-naming.md`.
- **What harness 2.1.206 actually provides:** Exactly this model. Official docs: teammates are addressed **by name**; "any teammate can message any other by that name"; `SendMessage` is always available to teammates; a message from another agent is flagged as coming from another session (not the user). Canon's session-unique-naming convention and cross-mailbox hazard note are **correct and current**. Evidence: official docs.
- **Drift severity:** `aligned`.
- **Recommended action:** None. Optionally strengthen: official docs add that `/resume` and `/rewind` do **not** restore in-process teammates ("the lead may attempt to message teammates that no longer exist") — this is directly relevant to Canon's Re-spawn Enrichment + escalation SendMessage-resume path and could be cited there as a known limitation.
- **Blast radius:** none (advisory enrichment only).

### 5. `SendMessage` mailbox semantics (re-spawn / stream-idle resume)

- **What Canon assumes / documents:** `references/escalation-protocol.md:42` — stream-idle stall → FIRST response is `SendMessage` resume; re-spawn is fallback. `CLAUDE.md:459`.
- **What harness 2.1.206 actually provides [orchestrator-probed]:** **Aligned — subagent-resume confirmed.** Live `SendMessage` schema states explicitly: "names keep working after an agent completes (a send resumes it from its transcript)"; the raw `agentId` is usable when the agent was spawned unnamed. Canon spawns **named** subagents, so the resume-first escalation posture is valid for exactly Canon's use case. (The orchestrator's mid-task message that delivered these probe results is itself the live proof of a send resuming a working agent.)
- **Drift severity:** `aligned`.
- **Recommended action:** None. The earlier "teammates-only" caveat is retired — named subagents are resumable.
- **Blast radius:** none.

### 6. `Monitor`

- **What Canon assumes / documents:** Appears only in `docs/supervised-build-quality.md:267,269` as **aspirational backlog** (M1: shipper waits on CI via `Monitor` + `gh pr checks --watch`; M2: auto-fix-on-CI-failure loop). Not on any live dispatch path. (My own Bash tool description in this session references "Monitor with an until-loop" for background waiting, so the primitive exists in some form.)
- **What harness 2.1.206 actually provides [orchestrator-probed]:** **Present.** Live schema `Monitor({ command | ws, description, timeout_ms, persistent })`. Only aspirational Canon references exist (M1/M2 backlog); no live dependency.
- **Drift severity:** `aligned` (present; unused).
- **Recommended action:** None until M1/M2 (CI-watch) are built — the confirmed shape is captured here for that work.
- **Blast radius:** `docs/supervised-build-quality.md` (backlog doc).

### 7. `Workflow` tool (Canon `workflows/` artifact class)

- **What Canon assumes / documents:** `workflows/CLAUDE.md:6,10,24,32` + `references/workflow-probe-matrix.md:14` — invoke via `Workflow({ scriptPath: "workflows/canon-probe.js" })`; plain-JS sandbox (no TS, no `Date.now()`/`Math.random()`/`new Date()` — resume-cache determinism); `script`/`resume` envelope deferred to Increment 1. `docs/adr/0028`. Canon already ships a dedicated **harness-upgrade-stability canary** (`workflows/canon-probe.js`, skill `canon:canon-probe`) whose entire purpose is to re-verify the Workflow tool after each harness upgrade.
- **What harness 2.1.206 actually provides [orchestrator-probed]:** **VERIFIED WORKING.** `Workflow({ scriptPath: "workflows/canon-probe.js" })` returned `{"probe_ok":true,"raw":{"ok":true,"note":"canon-probe passed"}}`. One `agent()` call succeeded, session hooks fired, and a schema-validated `StructuredOutput` object was returned. The `workflows/` artifact class is healthy on 2.1.206; `scriptPath` invocation and structured-output ingestion both work.
- **Drift severity:** `aligned`.
- **Recommended action:** None. The canary passed — this is the intended post-upgrade signal. (Optional: run canon-probe again on the next harness bump, per its canary purpose.)
- **Blast radius:** `workflows/*`, `references/workflow-probe-matrix.md`, `docs/adr/0028`, `mcp-server/src/shared/lib` (workflow lint).

### 8. Scheduling — `CronCreate` / `CronList` / `CronDelete` / `ScheduleWakeup` (loop framework)

- **What Canon assumes / documents:** `references/loop-framework.md:36-39,58-60,67-71` — interval loops dispatch via `CronCreate({ schedule, command, max })`; self-paced loops via `ScheduleWakeup({ delaySeconds, reason, prompt })`. `docs/adr/0017` (resilient inline tick prompt). `loops/*.md`, `templates/loop-definition.md`, `skills/canon/commands/loop-tick.md`, `principles/conventions/managed-artifact-class-shape.md`. `harness-tool-invocation-check.md:22,58` treats `CronCreate`/`ScheduleWakeup` as real orchestrator-session primitives with **zero codebase grep hits** (no source registration).
- **What harness 2.1.206 actually provides [orchestrator-probed]:**
  - **`CronCreate` — BROKEN call-shape (all 3 params wrong).** Live schema `CronCreate({ cron, prompt, recurring?, durable? })`. Canon docs at `loop-framework.md:37,58` document `CronCreate({ schedule, command, max })` → **`schedule` must become `cron`**, **`command` must become `prompt`**, **`max` is gone** (replaced by `recurring?` + a 7-day auto-expiry). Canon's `CronCreate` calls would fail as written.
  - **DURABILITY DESIGN ISSUE (deeper than a rename).** The live `CronCreate` docstring states jobs are **"session-only, in-memory, gone when Claude exits,"** auto-expire after 7 days, and the **`durable` param "has no effect — durable persistence is not available."** Canon's loop framework may assume durable, cross-session scheduling. This is a **design question, not a find/replace**: is Canon's real model per-session re-dispatch at named lifecycle hooks (`post-ship` / `session-start` / `on-long-dispatch`, per `loop-framework.md` non-declarative-invariant dc-06) — in which case session-scoped in-memory cron is *acceptable* and only the param names need fixing — or does any loop/routine rely on a job surviving a Claude exit? The dc-06 "only the orchestrator initiates scheduling at a named lifecycle moment" invariant *suggests* re-dispatch-per-session is the intended model, which would make session-scoping fine. Must be confirmed by the loop-framework owner before the doc fix.
  - **`ScheduleWakeup` — ALIGNED.** Live schema `{ delaySeconds, reason, prompt }` matches `loop-framework.md:39,69` exactly. Note: it is the `/loop` dynamic-mode tool (carries a `stop` field + autonomous-loop sentinels) — worth a one-line note in the loop docs.
  - **`/loop` + `/schedule` skills** coexist with these raw tools (they front the same capability); no forced migration, but a coexistence note is warranted.
- **Drift severity:** **`broken` (call-shape) on a LIVE path** for `CronCreate` + an open **design question** on durability; `aligned` for `ScheduleWakeup`.
- **Recommended action:** (1) Resolve the durability design question first (owner sign-off on the per-session re-dispatch model). (2) Then fix `loop-framework.md:37,58`: `schedule`→`cron`, `command`→`prompt`, drop `max`, add `recurring?`. (3) Add a one-line note that cron jobs are session-scoped/in-memory (7-day cap, `durable` inert) and that dc-06 lifecycle re-dispatch is the persistence mechanism. (4) Add the `ScheduleWakeup` `stop`-field note and a `/loop`/`/schedule` coexistence line.
- **Blast radius:** `references/loop-framework.md`, `loops/*`, `templates/loop-definition.md`, `skills/canon/commands/loop-tick.md`, routines subsystem, `docs/adr/0017`.

### 9. Artifact serving — `Artifact` tool vs `open_artifact`

- **What Canon assumes / documents:** `references/hitl-patterns.md:21-23` + `references/renderer-spawn-protocol.md:27` — orchestrator publishes the renderer's local HTML via the harness **`Artifact`** tool (stable per-build identity, re-render redeploys to same URL), presents the returned claude.ai URL, and **falls back to `open_artifact({ workspace, artifact_name })`** (localhost) on any `Artifact` failure. The renderer sub-agent does NOT call `Artifact` (not granted to sub-agents — decision `artifact-serving-02`). Memory: serving-layer retirement shipped #470 (`open_artifact` LIVE as fallback).
- **What harness 2.1.206 actually provides [orchestrator-probed]:** **ALIGNED.** Live `Artifact` schema takes a local `file_path` (`.html`/`.md`) + `favicon` + optional `url` for in-place update, returns a claude.ai URL, and supports `action: "list"`. This matches Canon's `hitl-patterns.md:21` publish-with-fallback design (stable per-build identity via the `url` re-deploy param; `open_artifact` localhost fallback).
- **Drift severity:** `aligned`.
- **Recommended action:** None. The optional `url` param confirms Canon's "re-render redeploys to the same URL" claim is achievable as documented.
- **Blast radius:** `references/hitl-patterns.md`, `references/renderer-spawn-protocol.md`, renderer flow.

### 10. `LSP` tool

- **What Canon assumes / documents:**
  - **Agent-facing docs (current & correct):** `agents/architect.md:100`, `agents/reviewer.md:88`, `agents/engineer.md:204` all cite the correct operation set — `findReferences, goToDefinition, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls, documentSymbol, workspaceSymbol` — and correctly state "no diagnostics operation."
  - **Stale evidence table:** `.canon/principles/conventions/harness-tool-invocation-check.md:53,78` documents the LSP operation set as **`{ listFiles, getReferences, findDefinition }`** (a PR #366-era snapshot) — **none of those three operation names exist in the current tool.**
  - `CLAUDE.md:397` — LSP prerequisite: requires `typescript-language-server` installed globally.
- **What harness 2.1.206 actually provides (LIVE-VERIFIED — I invoked it):** Operation set is **`goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls`** (9 operations, no diagnostics). `documentSymbol` succeeded against `mcp-server/src/features/orchestration/services/confidence-scorer.ts`, returning full symbol structure — so `typescript-language-server` **is present and working** in this environment. Evidence: direct live invocation.
- **Drift severity:** `stale-docs` (localized). The load-bearing agent guidance is already correct; only the historical evidence table in `harness-tool-invocation-check.md` names dead operations (`listFiles`/`getReferences`/`findDefinition`). The `CLAUDE.md:397` prerequisite note is **validated** (tool works here).
- **Recommended action:** Update `harness-tool-invocation-check.md:53,78-79` Evidence-table Instance-1 row to reflect the current 9-operation set (or annotate it explicitly as a *historical PR #366 snapshot* so it isn't read as the current surface). The rest of the LSP surface is aligned — no agent-doc change needed.
- **Blast radius:** `.canon/principles/conventions/harness-tool-invocation-check.md` (one evidence row; note `.canon/**` is gitignored/untracked overlay tier).

### 11. `PushNotification`

- **What Canon assumes / documents:** `CLAUDE.md:395` (build-complete fire), `references/hitl-patterns.md:22-23` (fire at plan-approval + review-verdict gates, mandatory regardless of tier), `references/loop-framework.md`, `docs/supervised-build-quality.md:251,268` + `docs/adr/0009` (OS-push-vs-terminal channel split). Not available on Bedrock/Vertex/Foundry; phone push needs Remote Control.
- **What harness 2.1.206 actually provides [orchestrator-probed]:** **CONFIRMED BROKEN call-shape on a live, mandatory-every-tier path.** Live schema `PushNotification({ message, status: "proactive" })` — **`status` is REQUIRED** (const `"proactive"`), there is **NO `title` param**, and `additionalProperties: false`. Canon's documented calls — `CLAUDE.md:395` (completion-checklist step 4 build-complete) and `hitl-patterns.md:22-23` (plan-approval + review-verdict gates) — use `PushNotification({ title: "...", message: "..." })`: they **omit the required `status`** and **pass a non-existent `title`** into an `additionalProperties:false` schema. **These calls fail/drop as written** — meaning HITL-gate and build-complete push notifications are silently non-functional on 2.1.206.
- **Drift severity:** **`broken` — LIVE, mandatory every tier.** This is the highest-impact finding: the push channel for every HITL gate and build-complete signal is broken.
- **Recommended action (High):** Fix every `PushNotification` call site: drop `title`, fold its content into `message`, and add `status: "proactive"`. Sites: `CLAUDE.md:395` (build-complete) and `references/hitl-patterns.md:22-23` (plan-approval, review-verdict). Grep `PushNotification(` across `CLAUDE.md`, `references/*.md`, `loops/*` for any other call sites and fix all. Add a runtime invocation AC per `harness-tool-invocation-check` so the fix is proven by a real fire, not just a doc edit.
- **Blast radius:** `CLAUDE.md`, `references/hitl-patterns.md`, `references/loop-framework.md`, and any loop/routine that fires push.

### 12. DAG parallel dispatch path (meta — dormancy status)

- **What Canon assumes / documents:** `references/dag-execution-protocol.md:16` — the live/exercised path is **single-worktree sequential**; the worktree-per-task parallel-wave path is documented-but-dormant. Wave-lifecycle helpers (`createWaveWorktrees`/`mergeWaveResults`/`cleanupWorktrees`) were removed in PR #167 (task brief also cites #191). "Do not reintroduce calls to the removed helpers."
- **What harness 2.1.206 actually provides:** N/A (this is a Canon-internal architecture fact, not a harness primitive). It is the **severity modulator** for §1–§3: all `TeamCreate`/`TeamDelete`/`Task*` drift sits on this dormant path, which is why those rate `stale-docs`/`unverified` rather than `broken`-on-a-live-path.
- **Drift severity:** `aligned` (Canon's own docs already flag the dormancy accurately).
- **Recommended action:** Any future re-activation of DAG parallelism is really a *port to the implicit-team model* (§1) + a `Task*` call-shape re-probe (§3), not a restore of the old helpers.
- **Blast radius:** conceptual; governs prioritization.

---

## Prioritized fix backlog (post-probe, re-ranked)

All `unverified` items have been resolved by the orchestrator probe pass. Ranking is now **confirmed severity × live-vs-dormant** — no speculation remains.

| Rank | Primitive | Severity | Path | Why it ranks here |
|------|-----------|----------|------|-------------------|
| **1** | **`PushNotification` call-shape** (§11) | **broken** | **live, mandatory every tier** | Live schema requires `status: "proactive"` and forbids `title` (`additionalProperties:false`). Canon's `{title, message}` calls at `CLAUDE.md:395` + `hitl-patterns.md:22-23` **fail/drop as written** → every HITL-gate and build-complete push is silently non-functional. Pure mechanical fix (drop `title`, add `status`), highest impact. |
| **2** | **`CronCreate` call-shape + durability design question** (§8) | **broken** + design | **live** (loop/routine dispatch) | All 3 params wrong (`schedule`→`cron`, `command`→`prompt`, `max`→gone/`recurring`). Jobs are session-only/in-memory (`durable` inert, 7-day cap). Resolve the "is per-session re-dispatch the real model?" design question (likely yes, per dc-06) **before** the doc fix. |
| **3** | **`TeamCreate`/`TeamDelete` + `dag-dispatch-guard` hook** (§1) | stale-docs + **live-hook aggravator** | dormant path, **live hook** | Tools gone; DAG build path dormant. But `hooks/dag-dispatch-guard.sh:77-78` is a registered hook whose warning text steers the orchestrator toward a dead tool. Rewrite the hook string + `dag-execution-protocol.md` to the implicit-team (`Agent({name})`) model. |
| **4** | **LSP stale evidence table** (§10) | stale-docs | localized | `harness-tool-invocation-check.md:53` names 3 dead ops (`listFiles/getReferences/findDefinition`). Agent-facing docs already correct. One-row fix (untracked `.canon/**` overlay). |
| **5** | **`Task*` call-shapes** (§3) | stale-docs (confirmed) | dormant | Real renames `task_id`→`taskId`, `title`→`subject`. No live consumer until DAG parallelism returns; fold into rank-3 rewrite. |
| **6** | **Availability-guard TODO redefine** (§2) | stale-docs | dormant (design-only) | Trigger ("cannot call TeamCreate") obsolete. Redefine against env-flag + `Agent({name})` success if/when DAG parallelism is rebuilt. |
| — | Workflow (§7), ScheduleWakeup (§8), Artifact (§9), SendMessage-resume (§5), Monitor (§6), Agent(name)+SendMessage (§4), DAG dormancy (§12) | **aligned** | — | Verified working / matching Canon's docs. No action. |

**Two live, broken, mechanical fixes (ranks 1–2) are the actionable core.** Both are call-shape corrections on paths that run every build; rank 2 additionally needs a one-question design confirmation on cron durability. Ranks 3–6 are doc/hook hygiene on a dormant path.

## Empirical-probe status — RESOLVED

The orchestrator (full session, holds the tools) probed every routed primitive against 2.1.206. Outcomes:

| Primitive | Result |
|-----------|--------|
| `Workflow({ scriptPath })` | ✅ working — `{probe_ok:true}`, hooks fired, StructuredOutput validated |
| `CronCreate` | ⚠️ broken call-shape — live `{ cron, prompt, recurring?, durable? }`; `durable` inert, session-only |
| `ScheduleWakeup` | ✅ aligned — `{ delaySeconds, reason, prompt }` (also `/loop` dynamic-mode tool; has `stop` field) |
| `PushNotification` | ⚠️ broken call-shape — live `{ message, status:"proactive" }`, no `title`, `status` required |
| `Task*` | ⚠️ minor drift — `TaskCreate({ subject })`, `TaskUpdate({ taskId })`; `owner`/`status`/`addBlockedBy` correct |
| `Artifact` | ✅ aligned — `{ file_path, favicon, url? }` → claude.ai URL, `action:"list"` |
| `SendMessage` | ✅ aligned — named agents resume from transcript after completion |
| `Monitor` | ✅ present — `{ command\|ws, description, timeout_ms, persistent }`; unused |
| `LSP` | ✅ live-verified in the original audit — 9-op set, no diagnostics |

No open probes remain.

## What is confirmed aligned (no action)

- `Workflow` scriptPath invocation + structured output (§7) — canary green on 2.1.206.
- `ScheduleWakeup`, `Artifact`, `SendMessage` named-resume, `Monitor` — all match Canon's docs / design (§5,§6,§8,§9).
- `Agent({ name })` + `SendMessage` name-based addressing, session-unique naming, cross-mailbox hazard (§4).
- LSP agent-facing operation guidance in `architect.md`/`reviewer.md`/`engineer.md` (§10) + `typescript-language-server` prerequisite (live-verified working).
- Canon's own documentation of the DAG parallel path as **dormant** (§12) — accurate.

---

*Investigation only. No code, protocol docs, or workspace state modified. Per-primitive verdicts and the backlog reflect the orchestrator's 2.1.206 probe pass folded in on 2026-07-10. This report is the delta map for choosing follow-up builds.*
