# Stock Claude Code Skills vs. Canon — Method-Level Comparison

## Status: Complete

**Mode:** Exploration (read-only, no code). **Date:** 2026-06-09.
**Question (user's hypothesis):** "I bet there's things we can learn for our approach."
**Scope:** 5 stock skill prompts vs. Canon's nearest equivalents, mining method-level lessons — adopt / steal / ignore — including where Canon is already better and should NOT change.

---

## ASSUMPTIONS

1. The 5 stock prompts captured under `docs/explore/advisor-strategy/stock-skills/` are faithful, current copies of the shipped Claude Code skills (the headers say "captured verbatim"). I did not re-fetch them from a live install. **Verified-in-repo**: file contents. **Inferred**: that they match the current shipped versions.
2. "Canon's equivalent" means the agent + supporting files that occupy the same functional slot (review, simplify, security, init/doc-bootstrap, run/verify). Canon has no 1:1 `simplify` or `run` agent — I map them to the closest functional surface (reviewer Stage 2 for simplify; tester + the verify-gate contract for run). **Inferred** mapping; flagged where it strains.
3. Stock skills are single-shot prompts a user invokes manually; Canon agents are orchestrated leaf workers in a journaled pipeline. Lessons are filtered through that structural difference — a technique that fits a one-shot prompt may be redundant or harmful inside an orchestrated flow.
4. Where I say "Canon already does X," I cite agent file:line. Where I infer intent from the prompt text rather than observed behavior, I mark it **inferred**.

→ Correct any of these before acting on the recommendations.

---

## Pair 1 — `code-review` vs. Canon `reviewer`

### What the stock skill does (method)

`docs/explore/advisor-strategy/stock-skills/code-review.md`:

- **Recall-biased, not precision-biased.** The opening contract is explicit: "reviewing for **recall** at high effort… catching real bugs matters more than avoiding false positives. Err on the side of surfacing" (lines 7-9). This is a deliberate stance choice stated up front.
- **Fan-out into 7 named finder angles** (lines 20-82): 3 correctness (line-by-line scan, removed-behavior auditor, cross-file tracer), 3 cleanup (reuse, simplification, efficiency), 1 altitude. Each angle is a separate Agent-tool sub-task, each capped at **6 candidates** with a required `failure_scenario`.
- **A distinct "removed-behavior auditor" angle** (lines 35-40): for every deleted line, name the invariant it enforced, then search the new code for where that invariant is re-established. This is a method most reviewers skip.
- **An "altitude" angle** (lines 72-77): is the change at the right depth, or a special-case bandaid layered on shared infra? Prefer generalizing the mechanism.
- **A 3-verdict verify stage** (lines 88-106): one verifier per deduped candidate returns CONFIRMED / PLAUSIBLE / REFUTED. The doc spells out exactly what is PLAUSIBLE-by-default (realistic runtime states: races, nil-on-rare-path, falsy-zero, off-by-one on a non-excluded boundary) vs. what may be REFUTED (constructible-from-code: factually wrong, provably impossible, already-handled, pure-style).
- **Hard output cap (≤10)** in a flat JSON shape: `file`, `line`, `summary`, `failure_scenario`. Ranked most-severe first. Correctness always outranks cleanup when the cap forces a cut (lines 81-82).

### What Canon's `reviewer` does

`agents/reviewer.md`:

- Six **stages** (line 53): principle compliance, principle-informed quality, compliance cross-check, drift-from-plan, AC verification, cross-requirement consistency.
- **Precision-biased by construction.** "Avoiding false positives" (line 161), "False negatives are better than false positives" (line 795), and a Confidence tier annotated per finding (lines 557-565). Severity maps to a verdict (BLOCKING/WARNING/CLEAN, lines 740-760).
- **Mechanical Verification Mandate / BUG-Default Rule** (lines 123-141): every principle starts NOT-YET-VERIFIED, every AC starts NOT-MET; both require file:line positive evidence. This is Canon's recall mechanism — but pointed at *compliance*, not at *bugs*.
- Fan-out is **orchestrator-driven** (blast-radius partitioning in root `CLAUDE.md`), not skill-internal. A single reviewer runs all six stages; parallelism is across files, not across angles.

### Delta (method, not wording)

1. **Stance is opposite and explicit.** Stock code-review optimizes recall ("surface everything, verify down"); Canon reviewer optimizes precision ("assume not-violated, prove up"). Both use a verify gate, but in opposite directions: stock verifies candidates *down* to drop false positives; Canon verifies claims *up* from a BUG-Default floor.
2. **Stock fans out by reasoning angle; Canon fans out by file.** Canon has no equivalent to "7 independent finder angles each capped at 6." Its single reviewer carries all the lenses in one context. The stock model is a map-reduce over *ways of looking*; Canon's is a map-reduce over *what to look at*.
3. **Canon has no bug-hunting stage at all.** This is the load-bearing finding. Every Canon reviewer stage is anchored to a *principle*, a *plan*, an *AC*, or a *cross-requirement surface*. There is no stage whose job is "find the off-by-one / missing-await / inverted-condition a careful human would catch." Stages 1-2 catch bugs only insofar as a loaded principle names the bug class. The stock skill's Angle A (line-by-line) and Angle B (removed-behavior) are pure correctness hunts with no principle dependency — Canon structurally cannot produce those findings.
4. **Stock's "altitude" angle ≈ Canon's `consistent-abstraction-levels` / "deep modules" craft dimension** (reviewer `interface-depth`, line 397) — but stock applies it as a *diff-level bug hunt* ("is this fix a bandaid?"), Canon applies it as a *craft rating*. Same concept, different altitude of application.

### Lessons: adopt / steal / ignore

- **ADOPT — a principle-independent correctness pass.** *File to change:* `agents/reviewer.md`. Add a Stage 1.5 (or a sub-axis in Stage 2) "Correctness Scan" that runs stock's Angle A + Angle B verbatim in spirit: line-by-line over each hunk *plus the enclosing function*, and a removed-behavior auditor. This is the single biggest gap — Canon's reviewer can pass a diff CLEAN that has an inverted condition, because no loaded principle names "inverted condition." Canon's own memory corroborates the cost: a 19% corrective-build baseline from Codex catching what the reviewer missed (`project_codex_defect_class_reviewer_preemption`). The stock skill is a ready-made template for the missing pass.
- **STEAL — the "removed-behavior auditor" as a discrete obligation.** *File to change:* `agents/reviewer.md` Stage 1 or the new correctness stage. "For every deleted line, name the invariant it enforced; find where it's re-established; if you can't, that's a finding." Canon has Stage 4 drift-from-plan (did we change the right *files*) but nothing that audits deleted *behavior*. This is cheap and high-yield.
- **STEAL — recall-vs-precision as an explicit, switchable stance.** Stock states its stance in line 1. Canon's precision bias is implicit and scattered (lines 161, 795). Make it explicit and **mode-dependent**: a pre-PR/advisory review should run recall-biased (surface everything for the author); a gate review should run precision-biased (only block on proven violations). Canon already has the dual-use surface — the Codex-mining work (`project_codex_defect_class_reviewer_preemption`) added pre-PR checks. Naming the stance per mode would sharpen both.
- **IGNORE — the flat ≤10 JSON output and the 3-verdict CONFIRMED/PLAUSIBLE/REFUTED machinery.** Canon's `write_review` structured artifact (violations[], honored[], score{}, craft_profile, recommendations, server-computed confidence tiers, lines 519-565) is strictly richer and feeds drift analytics, the craft store, and the renderer. The stock skill's verify-stage *reasoning* (what's PLAUSIBLE-by-default) is worth importing as guidance prose, but its verdict *vocabulary* and output shape are a downgrade. **Don't touch the artifact.**
- **IGNORE — internal 7-way Agent fan-out.** Canon's fan-out is blast-radius-driven and orchestrator-owned (root `CLAUDE.md` Team Dispatch Protocol). Re-introducing a skill-internal 7-subagent fan-out inside one reviewer would collide with the orchestrator's partitioning and the journal. The *angles* are valuable as a checklist; the *parallel dispatch of them* is not, in Canon's model.

---

## Pair 2 — `simplify` vs. Canon reviewer Stage 2 + simplicity principles

### What the stock skill does (method)

`docs/explore/advisor-strategy/stock-skills/simplify.md`:

- **Cleanup-only, explicitly NOT bug-hunting** (lines 7-9): "Do not look for correctness bugs — that is what `/code-review` is for." Clean separation of concerns between the two skills.
- **4 parallel cleanup agents** (lines 20-55): reuse, simplification, efficiency, altitude — the same 4 cleanup/altitude angles from code-review, reused verbatim.
- **It FIXES, not just flags** (lines 57-64): after dedup, it applies each fix directly, skipping any that would change behavior or reach outside the diff, and ends with a what-was-fixed / what-was-skipped summary.
- **The "reuse" angle is concrete** (lines 29-32): "Grep shared/utility modules and files adjacent to the change, and name the existing helper to call instead."

### What Canon's equivalent does

- **No dedicated simplify agent.** The functional slot is split:
  - `simplicity-first` (`principles/strong-opinions/simplicity-first.md`) — "fewer concepts, fewer files, fewer layers… add complexity only when the current approach has demonstrably failed" (line 13). Explicitly motivated by AI over-engineering bias (lines 17-19).
  - `leave-touched-files-better` (`principles/strong-opinions/leave-touched-files-better.md`) — the Boy Scout Rule, with the deliberate constraint **"only files already being modified"** (line 25): no repo-wide sweep, no cleanup sprint.
  - `read-only-tool-reuse-over-reimplementation` (`principles/conventions/read-only-tool-reuse-over-reimplementation.md`) — the reuse angle, but narrowly scoped to new MCP tools reusing internal helpers (line 14).
  - reviewer Stage 2 (`agents/reviewer.md` lines 185-204) flags over-engineering, naming, etc., but is **advisory by default** (line 197) and only *flags* — the **engineer** fixes, governed by `leave-touched-files-better`.

### Delta (method, not wording)

1. **Stock simplify is an apply-fixes actuator; Canon splits flag (reviewer) from fix (engineer).** Stock collapses detect+fix into one skill. Canon deliberately separates them across the pipeline — the reviewer never edits code.
2. **Stock's reuse angle greps for existing helpers at review time, on ANY code.** Canon's reuse enforcement (`read-only-tool-reuse-over-reimplementation`) is scoped to *MCP tools in `mcp-server/src/**`* (line 7-8 scope block). There is **no general "did this diff re-implement an existing helper?" check** in the reviewer. This is a real coverage gap — the stock angle is broader than Canon's principle.
3. **Stock's "altitude" appears in BOTH code-review and simplify** — it treats "fix at the wrong depth" as both a correctness risk and a cleanup issue. Canon folds this into the `interface-depth` craft dimension and `consistent-abstraction-levels`, but only as a rating/principle, never as an actionable "generalize this mechanism" instruction.
4. **Constraint alignment is strong.** Stock's "skip any fix that reaches outside the reviewed diff" (line 61) is *exactly* `leave-touched-files-better`'s "never in files you aren't already changing" (line 25). Two independent designs converged on the same scope-discipline rule. **Canon is already right here — don't touch it.**

### Lessons: adopt / steal / ignore

- **ADOPT — a general reuse-detection sub-axis in reviewer Stage 2.** *File to change:* `agents/reviewer.md` (add a Stage 2 sub-axis modeled on the existing "Peer-Consumer Consistency" axis, lines 274-292). The instruction: "For new functions/blocks in the diff, grep shared/utility modules and files adjacent to the change for an existing helper that does the same job; name it." Canon's reuse enforcement today only fires for MCP tools; the stock skill reuses helpers everywhere. Low effort — Canon already has the grep-adjacent-modules muscle in the Peer-Consumer axis; this generalizes it from "same utility, different call" to "different code, same job."
- **STEAL — the explicit code-review ↔ simplify division of labor as a documented contract.** Canon has the division (reviewer flags, engineer fixes) but it's implicit. The stock pair makes it a stated contract ("bugs → code-review, cleanup → simplify"). Worth a one-line note in `agents/reviewer.md` Stage 2 intro: "This stage flags; remediation is the engineer's under `leave-touched-files-better`." Prevents reviewers from editorializing fixes they can't apply.
- **IGNORE — the apply-fixes actuator model.** Canon's reviewer is `permissionMode: acceptEdits` but is structurally a non-editing role (it writes only REVIEW.md). Letting the reviewer apply simplify-fixes would break cold review, the journal, and the fix-iteration loop. Canon's separation is a feature. **Don't merge detect+fix.**
- **IGNORE — re-importing the 4 cleanup angles as a separate agent.** They already live in reviewer Stage 2 + the craft profile. A standalone Canon `simplify` agent would duplicate Stage 2 and fragment the review artifact.

---

## Pair 3 — `security-review` vs. Canon `security`

### What the stock skill does (method)

`docs/explore/advisor-strategy/stock-skills/security-review.md` (static template starts line 82, "OBJECTIVE:"):

- **Precision-maximalist, the opposite stance from code-review.** "MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability" (line 86); final confidence filter is **≥8/10** (line 236).
- **An enormous, concrete exclusion list** — 17 HARD EXCLUSIONS (lines 185-203) + 12 PRECEDENTS (lines 205-218). These encode hard-won false-positive lore: don't report DOS, don't report secrets-on-disk, don't report command injection in shell scripts unless concretely triggerable by untrusted input (line 217), env vars and CLI flags are trusted (precedent 3), React/Angular are XSS-safe absent `dangerouslySetInnerHTML` (precedent 6), don't report findings in markdown/docs (exclusion 16), client-side authz absence is not a vuln (precedent 8).
- **A fixed taxonomy of categories to examine** (lines 94-130): input validation, auth/authz, crypto/secrets, injection/RCE, data exposure — each with named sub-types.
- **3-phase methodology** (lines 134-152): repo context research (find existing security patterns) → comparative analysis (deviations from established practice) → vulnerability assessment (trace data flow input→sink).
- **2-pass sub-task structure** (lines 232-237): pass 1 identifies vulns; pass 2 spawns one parallel false-positive-filter sub-task per finding, each carrying the full FALSE-POSITIVE-FILTERING block; then drop anything < confidence 8.
- **Rigid output format** (lines 154-166): per-finding file, line, severity, category, description, exploit scenario, fix recommendation.

### What Canon's `security` does

`agents/security.md`:

- **`agent-assume-hostile-input`** core stance (line 39) — every external boundary hostile until validated. This is a *recall* posture at scoping time.
- **`maxTurns: 25`** (line 9) — tightly budgeted; the cheapest of the opus agents.
- **False-positive verification** (lines 106-108): confirm SQLi string reaches a query executor not a log line; confirm a "secret" is a real credential not a fixture. Precision applied per-finding, like the stock skill — but as *one paragraph*, not a 29-item list.
- **No severity downgrade for context** (lines 120-122): "only reachable from internal tooling" / "behind a feature flag" does NOT reduce severity. This is the **exact opposite** of how the stock skill reasons in several precedents (e.g., it down-weights shell-script command injection, GitHub-action vulns).
- **Stack detection** (lines 94-97) to skip inapplicable categories — same idea as the stock skill's repo-context phase.
- **Planned-security-controls check** (lines 124-134): verify controls named in DESIGN.md were actually implemented — a *plan-aware* check the stock skill has no equivalent for (the stock skill has no plan).
- **early-scan mode** (lines 59-73): ≤200-token inline advisory at design time. The stock skill is single-mode.
- Checklist lives in `references/security-checklist.md` (referenced line 105), not inlined.

### Delta (method, not wording)

1. **Both are precision-biased, but encode it completely differently.** Stock: a 29-item static exclusion/precedent list baked into the prompt. Canon: a one-paragraph "verify exploitability" rule + a no-context-downgrade rule + a referenced checklist. Stock front-loads *what NOT to report*; Canon front-loads *the posture* and trusts the agent to apply it.
2. **Direct philosophical conflict on contextual mitigation.** Stock down-weights/excludes findings based on reachability context (shell scripts, GitHub actions, internal-only). Canon explicitly *refuses* to downgrade on those same grounds (lines 120-122). These are genuinely opposed design choices — Canon's is defensible (an exploitable bug is exploitable) but produces more findings on exactly the categories stock learned to suppress.
3. **Canon is plan-aware and multi-mode; stock is neither.** Canon's Step 4.5 (planned controls) and early-scan mode have no stock analog — they exist *because* Canon is an orchestrated pipeline with a DESIGN.md upstream.
4. **Stock's exclusion list is a body of empirical false-positive knowledge Canon lacks in concrete form.** Canon's checklist (not read here) may cover some, but the stock list's precedents — "env vars are trusted," "client-side authz absence isn't a vuln," "don't flag docs," "shell-script cmd-injection needs a concrete untrusted-input path" — are precisely the noise sources that make security scans annoying.

### Lessons: adopt / steal / ignore

- **ADOPT — import the stock exclusion list as a curated false-positive precedent set.** *File to change:* `references/security-checklist.md` (add an "Exclusions & Precedents" section). The 17 exclusions + 12 precedents are battle-tested noise filters. This is the highest-value, lowest-effort steal across all 5 pairs: it's pure prose, drops straight into an existing referenced file, and directly attacks the false-positive problem the agent already says it cares about (lines 106-108). **Caveat:** reconcile against Canon's no-downgrade rule (next bullet).
- **STEAL (with adjudication) — resolve the contextual-mitigation conflict deliberately.** The stock list and Canon's lines 120-122 directly contradict each other on shell-script command injection and reachability. Don't blindly import. The right synthesis: keep Canon's "no severity *downgrade* for context" but adopt the stock distinction between *severity* and *reportability* — a finding can be real-but-out-of-threat-model. Canon's `info` severity (line 120) is the natural home. Document the adjudication in the checklist so it's a decision, not a silent inconsistency.
- **STEAL — the explicit confidence threshold.** Stock states ">80% / ≥8" numerically. Canon says "verify it's exploitable" qualitatively. A stated numeric bar gives the agent a crisper cut line. Minor, prose-only.
- **IGNORE — the 2-pass parallel false-positive-filter sub-task structure.** Canon's `security` is `maxTurns: 25` (line 9) and orchestrated; spinning one filter sub-task per finding would blow the budget and duplicate the per-finding verification it already does inline (lines 106-108). The *idea* (a dedicated FP-filter pass) is sound, but Canon's single-pass inline verification + the orchestrator's separate reviewer already provide the second set of eyes.
- **IGNORE — inlining the full category taxonomy into the agent.** Canon correctly externalizes it to `references/security-checklist.md`. Inlining (as stock does) bloats the prompt and duplicates the reference. **Canon's split is better — don't inline.**

---

## Pair 4 — `init` vs. Canon `/canon:init` + `scribe`

### What the stock skill does (method)

`docs/explore/advisor-strategy/stock-skills/init.md` — strikingly short (24 lines):

- **One job: write/improve a CLAUDE.md** by analyzing the codebase. Two content targets (lines 5-8): (1) commonly-used commands (build, lint, test, *run a single test*), (2) big-picture architecture "that requires reading multiple files to understand."
- **Anti-bloat is the dominant theme.** Most of the prompt is *what NOT to write* (lines 10-16): don't repeat yourself, don't include obvious instructions, don't list every file/component "that can be easily discovered," don't include generic dev practices, **don't make up sections** like "Common Development Tasks" / "Tips" unless they came from a real source file.
- **Harvest existing sources** (lines 13-15): pull important parts from Cursor rules, Copilot instructions, README.
- **Fixed prefix** (lines 17-23) so every generated CLAUDE.md is identifiable.

### What Canon's equivalent does

Split across two surfaces:

- `/canon:init` (`skills/canon/commands/init.md`) — bootstraps the *Canon* layer: `.canon/` dirs, config.json, the Canon Orchestration + Principles sections appended to CLAUDE.md (lines 58-82), and **auto-detects conventions** by sampling 10-20 source files to pre-populate `.canon/CONVENTIONS.md` (lines 84-122). Then runs an adoption scan (Step 7).
- `scribe` (`agents/scribe.md`) — the *ongoing maintenance* of CLAUDE.md/context.md/CONVENTIONS.md, diff-driven and contract-scoped (line 46). It has a detailed **anti-bloat exclusion list** (lines 137-143): don't document removed modules, no field-by-field interface docs, no signatures that restate types, one-line-per-contract (line 147), "if your entry exceeds 120 characters you are writing too much."

### Delta (method, not wording)

1. **Stock init is a one-shot greenfield bootstrap of a *generic* CLAUDE.md; Canon splits bootstrap (init command) from maintenance (scribe).** Canon's init is Canon-specific (it installs the orchestration contract), and the *general* "describe architecture + commands" job is largely assumed-or-deferred. Canon has **no general-purpose "analyze this repo and write a good architecture CLAUDE.md" step** — `/canon:init` writes the Canon sections and detects conventions, but does not do stock-init's core job of distilling big-picture architecture into CLAUDE.md.
2. **Both converge hard on anti-bloat — independently.** Stock init lines 10-16 and scribe lines 137-158 are the same philosophy: one line per item, no obvious/generic content, no restating what's discoverable, don't invent sections. **Strong convergence — Canon is already right.**
3. **Stock init harvests Cursor/Copilot/README; Canon init does not.** Canon's init reads config files for stack detection (line 88) but doesn't pull existing AI-rules (`.cursorrules`, `.github/copilot-instructions.md`) into CLAUDE.md. For adoption-into-an-existing-repo, that's a real miss.
4. **Canon init auto-detects conventions; stock init does not.** Canon's convention-sampling (lines 84-122) is a capability stock init lacks. **Canon is ahead here.**

### Lessons: adopt / steal / ignore

- **ADOPT — harvest existing AI-rule files during `/canon:init`.** *File to change:* `skills/canon/commands/init.md` (Step 4 or a new Step 4b). Add: "If `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` exist, extract their load-bearing rules into the generated CLAUDE.md / CONVENTIONS.md." Canon installs into existing repos; those repos often already have AI-rules that encode real constraints. Stock init treats this as a first-class step; Canon ignores it. Low effort, real adoption value.
- **STEAL — the "big-picture architecture that requires reading multiple files" framing.** *File to change:* `skills/canon/commands/init.md` and/or the scribe's CLAUDE.md template guidance. Stock init's sharpest line is the *selection criterion* for what belongs in CLAUDE.md: architecture you can only understand by reading several files. That's a better inclusion test than Canon's current "contract-level changes" framing for the *initial* doc. Canon's scribe is great at *maintaining* contracts but there's no stated rule for what the *first* architecture description should contain. Import the criterion.
- **IGNORE — stock init's generic single-file model.** Canon's two-layer split (one-shot init for Canon scaffolding + diff-driven scribe for maintenance) is more robust than a one-shot generic writer. A generic CLAUDE.md goes stale the moment code changes; scribe's diff-driven contract-scoped maintenance (line 46) is the better long-run design. **Don't collapse to one-shot.**
- **IGNORE — stock init's anti-bloat list as a new addition.** Canon already has an equal-or-better one in scribe (lines 137-158). Convergent, already covered.
- **"Canon is already better, don't touch":** convention auto-detection (init Step 5), diff-driven contract-scoped maintenance (scribe), and the anti-bloat exclusion list (scribe lines 137-158). All three exceed stock init.

---

## Pair 5 — `run` vs. Canon `tester` + verify-gate contract

### What the stock skill does (method)

`docs/explore/advisor-strategy/stock-skills/run.md` (the richest of the 5, with 6 inlined example archetypes):

- **A hard definition of "running":** launch the actual app and *interact* with it as a user would — "not the test suite, not an `import` and a `console.log`" (lines 6-9). "Launching with no interaction… is typechecking with extra steps" (lines 57-59).
- **Project-skill-first** (lines 11-32): before improvising, walk up the dir tree grepping for an existing `.claude/skills/*/SKILL.md` that already launches this app — "the repo's verified path… the exact `apt-get` line, the env vars, the patches" (lines 12-16). Use it verbatim. If stale, offer to regenerate via `/run-skill-generator`.
- **Archetype-driven dispatch** (lines 35-53): a 6-row table mapping project shape → handle mechanism → worked example. CLI (exit code/stdin), web server (background launch + curl smoke), TUI (tmux send-keys/capture-pane), Electron (Playwright `_electron` REPL under xvfb), browser (chromium-cli), library (import-and-call smoke at the package boundary).
- **The examples encode deep, specific operational knowledge:** poll-for-readiness not `sleep N` (server.md, tui.md, playwright.md, repeatedly); background-launch + PID capture + clean kill (server.md); `--no-sandbox` is almost always needed in containers (electron.md); `locator.click()` hits the wrong layer when content is in a BrowserView, use DOM `.click()` (electron.md); React controlled inputs need `fill`/`type` not `el.value=` (playwright.md); "check `console --errors` before declaring success — a page can render its shell while every data fetch 500s" (playwright.md).
- **A graduation path:** when a fallback pattern needed real setup work (apt packages, env, patches, a driver), recommend capturing it as a project skill via `/run-skill-generator` so the next agent inherits it (lines 67-71).

### What Canon's equivalent does

Split across two surfaces:

- `tester` (`agents/tester.md`) — writes integration + e2e tests. Has a **Mandatory E2E Smoke Test for user-observable ACs** (lines 72-78): "exercise the full call path from entry point through all composed functions to the observable output… answers: if a user triggers this feature, does the observable thing actually happen?" This is the *closest* Canon analog to stock-run's "drive it, don't just launch it." But it's a *test*, not a live drive.
- The **verify-gate contract** (root `CLAUDE.md` line 386): `npm run build` → `npm run lint` → `npm test` → `bash hooks/lint.sh`, all exit 0.
- **Framework detection** (tester lines 137-143): vitest/jest/pytest/go by config file — the same "detect the shape" instinct as stock-run's archetype table, but narrowly for *test* frameworks.

### Delta (method, not wording)

1. **Stock-run launches and drives the live app; Canon never does.** Canon's strongest analog (tester e2e smoke, lines 72-78) exercises the call path *in a test harness*, and the verify gate runs the *test suite* — exactly the two things stock-run says are NOT running ("not the test suite, not an import-and-console.log"). **This is the deepest gap of the 5 pairs.** Canon has no step that starts the server and curls it, no step that screenshots the UI, no step that drives a CLI and checks the exit code against a real invocation. Canon verifies *that tests pass*, not *that the app runs*.
2. **Stock-run is archetype-driven; Canon is framework-driven.** Stock-run's 6 archetypes are about *app shape and how to drive it live*. Canon's detection is about *test runner*. Canon has no notion of "this is a web server, smoke it with curl" vs. "this is a TUI, drive it with tmux."
3. **Stock-run has a project-skill cache + graduation path; Canon has no equivalent for run-knowledge.** Stock-run's first move is "did someone already capture how to run this?" and its last move is "capture what you learned." Canon's tester re-derives test setup each run. (Canon *does* have agent-memory for some agents, but nothing that persists "here's the exact apt/env/patch sequence to launch this app.")
4. **Convergence on poll-don't-sleep and observable-output.** Stock-run hammers "poll for readiness, never `sleep N`" and "look at the screenshot / check console errors." Canon's tester e2e mandate ("does the observable thing actually happen," line 76) shares the *intent*. But Canon expresses it as a test assertion; stock-run expresses it as a live interaction.

### Lessons: adopt / steal / ignore

- **ADOPT — a live "smoke the running app" step for user-observable builds.** *File to change:* root `CLAUDE.md` verify-gate contract (line 386) and/or `agents/tester.md`. For builds whose ACs are user-observable (HTTP endpoint, CLI output, served page), add a verify sub-step that *runs the app and drives it* — background-launch + readiness-poll + curl/CLI-invocation/screenshot — distinct from `npm test`. Canon's tester already *knows* which ACs are user-observable (lines 72-78); today it only writes a test for them. Stock-run's server.md / cli.md examples are drop-in recipes. This closes the "tests pass but the app doesn't boot" gap — a class Canon's own history knows well (the MCP-boot regressions in memory: `project_v290_boot_regression_fixes`, `project_mcp_boot_esm_nodepath_bug`).
- **STEAL — the archetype→drive-mechanism table as tester (or verify-step) guidance.** *File to change:* `agents/tester.md` (extend the framework-detection step). Add an app-shape detection table: web-server → curl smoke; CLI → exit-code/stdin; TUI → tmux; browser → headless screenshot; library → import-and-call. Even if Canon only adopts the server + CLI rows initially, the structure is valuable. The "poll-for-readiness, never `sleep N`" and "check console errors before declaring success" gotchas are pure gold and apply directly to Canon's own MCP-server smoke testing.
- **STEAL — the project-skill graduation path, mapped onto Canon's managed-artifact model.** Stock-run captures hard-won launch knowledge as a committed project skill. Canon has a managed-artifact culture (routines, loops — `project_routines_artifact_class_shipped`, `project_loop_integration_explored`). A "run recipe" could be a new managed artifact or a `routines/` entry: "how to boot + smoke this project." This is higher-effort but philosophically native to Canon.
- **IGNORE — the Electron/Playwright/xvfb/tmux REPL driver machinery wholesale.** Canon is itself an MCP server + plugin (a CLI/server/library shape), not a desktop-GUI shop. The electron.md driver skeleton (200+ lines) is irrelevant to Canon's own repo. Adopt the *server* and *library* archetypes; ignore the GUI ones until a consuming project needs them.
- **"Canon is already better, don't touch":** the tester's user-observable-AC *detection* (lines 72-78) is a precise trigger stock-run lacks — stock-run relies on the agent's judgment to decide what to drive; Canon mechanically identifies observable ACs from the runbook. Keep that trigger; just extend what fires on it from "write a test" to "also drive the live app."

---

## Cross-cutting lessons for Canon's approach

### 1. Archetype/example-driven dispatch — **CONFIRM (partially adopt)**

**Evidence:** `run` is the strongest case — 6 archetypes, each a worked recipe, dispatched by project shape (run.md lines 35-53). `security-review` does a softer version (fixed category taxonomy, lines 94-130). `code-review`/`simplify` use *reasoning-angle* archetypes (the 7/4 finder angles) rather than *domain* archetypes.

**Verdict:** Canon agents today carry **general instructions + principle bodies**, not archetype playbooks. The archetype model wins specifically where the *correct method depends on the shape of the target* — which is `run` (app shape dictates drive mechanism) and partially `security` (stack dictates category set). It does NOT win for `architect`/`reviewer`, where the method is uniform and the *content* (which principles, which files) varies. **Adopt archetypes for the tester/verify surface (app-shape → drive-mechanism); do not retrofit them onto reasoning agents** where they'd just be a checklist Canon already has as principles.

### 2. Self-contained prompt density vs. Canon's split — **REJECT as a wholesale change, but note the tax**

**Evidence:** Every stock skill is a single dense prompt (security-review inlines its entire 29-item exclusion list; run inlines 6 full examples). Canon splits across `agents/*.md` + `rules/` + `references/` + `primers/` + `templates/`, assembled by `resolve_agent_skills`.

**Trade-off, honestly:** The stock model's advantage is *legibility and atomic editability* — the whole behavior is in one file you can read top-to-bottom and reason about. Canon's split has a real cost the codebase already feels: the dead-wire defect class (`project_evaluate_step_dead_wire`, `project_batch6_dead_scope_tags_principles` in memory) is *precisely* a symptom of behavior fragmented across files where one piece silently stops matching another. Stock skills structurally can't dead-wire — there's nothing to wire.

**Verdict:** Canon's split is the right call for an orchestrated multi-agent system (you cannot inline 78 principles into every agent). But the stock skills are a reminder that **density has value Canon pays to give up**, and the mitigation is exactly what Canon is already building: mechanical wiring checks (the reviewer's Agent→Tool Reachability and Structural Assertion Grep Scope sub-axes, lines 258-339). Keep the split; keep investing in dead-wire detection. **No file change recommended — this is a "stay the course, eyes open" finding.**

### 3. Severity/output discipline — **Canon already wins; one small steal**

**Evidence:** Stock code-review caps at ≤10 flat JSON findings; security-review uses a fixed markdown finding shape + numeric confidence. Canon's `write_review` is richer (structured violations + honored + score + craft_profile + recommendations + server-computed confidence tiers, reviewer lines 519-565) and feeds drift analytics, the craft store, and the renderer.

**Verdict:** Canon's output discipline is **strictly superior** — don't touch the artifacts. The one transferable idea is the **explicit numeric confidence bar** (security-review's ">80% / ≥8"). Canon computes confidence server-side post-hoc; stating an *authoring-time* threshold ("don't surface below X confidence") would sharpen the agent's own cut line before the server annotates. Minor, prose-only.

### 4. Scoping technique — **two different axes; Canon's is better for impact, stock's is better for bug-locality**

**Evidence:** Every stock skill scopes via **the diff** (`git diff @{upstream}...HEAD`, with a fallback ladder and working-tree inclusion — code-review.md lines 11-18, repeated in simplify). Crucially, code-review then *expands*: "Read the enclosing function for each hunk — bugs in unchanged lines of a touched function are in scope" (lines 28-31). Canon scopes via **KG blast radius** (`get_context` with file_context + graph, partitioning by `in_degree`/`impact_score`).

**Delta:** Stock = diff-centric + *function-local expansion* (the bug might be in the unchanged lines around your change). Canon = diff-centric + *dependency-graph expansion* (the bug's blast radius is its dependents). These are **orthogonal and complementary**: stock zooms *into* the touched function; Canon zooms *out* to the touched function's callers.

**Verdict — ADOPT the function-local expansion.** *File to change:* `agents/reviewer.md` (the new correctness stage from Pair 1, or Stage 0/1). "For each changed hunk, read the *entire enclosing function*, not just the diff lines — a touched function's unchanged lines are in scope because the change re-exposes or fails to fix them." Canon's blast-radius scoping is excellent at "what does this affect" but says nothing about "is the rest of this function, which I'm now touching, also broken." Cheap, high-yield, and it pairs naturally with the removed-behavior auditor.

### 5. (Bonus) Stance declaration — **the meta-lesson across all 5**

The single clearest cross-cutting pattern: **each stock skill declares its precision/recall stance in its first lines and lives by it.** code-review: recall ("err on the side of surfacing"). security-review: precision (">80%, ≥8, minimize false positives"). simplify: scoped-cleanup-only. run: "launch and drive, not typecheck." init: "anti-bloat, don't make things up." Canon's agents have these stances too, but **scattered and implicit** — the reviewer's precision bias is spread across lines 161, 197, 795. **Lesson:** lead each Canon agent file with a one-line explicit stance declaration. Near-zero effort, improves agent self-consistency, and makes mode-switching (recall-pre-PR vs. precision-gate) a deliberate knob rather than an accident.

---

## Top 3 adoptable lessons, ranked by value/effort

| Rank | Lesson | Value | Effort | File(s) to change |
|------|--------|-------|--------|-------------------|
| **1** | **Add a principle-independent correctness pass to the reviewer** (stock code-review Angle A line-by-line + Angle B removed-behavior auditor + function-local expansion from cross-cutting #4). Canon's reviewer structurally cannot catch inverted conditions / missing awaits / dropped invariants today — every stage is principle/plan/AC-anchored. This is the biggest functional gap and directly attacks Canon's measured 19% Codex-corrective-build baseline. | Very high | Medium | `agents/reviewer.md` (new Stage 1.5 + Stage 0 enclosing-function read) |
| **2** | **Import the security-review exclusion/precedent list into the security checklist** (17 exclusions + 12 precedents). Pure prose, drops into an existing referenced file, directly cuts false-positive noise the agent already says it cares about. One adjudication needed against Canon's no-context-downgrade rule (use `info` severity). | High | Low | `references/security-checklist.md` |
| **3** | **Add a live "smoke the running app" verify sub-step for user-observable builds** (stock run's "drive it, don't just launch it" + server/CLI archetypes). Canon verifies that *tests pass*, never that the *app boots* — a gap its own MCP-boot regression history proves is real. Tester already detects user-observable ACs; extend the trigger from "write a test" to "also drive the live app." | High | Medium | root `CLAUDE.md` verify gate (line 386); `agents/tester.md` |

**Runners-up (lower value/effort ratio):** general reuse-detection sub-axis in reviewer Stage 2 (Pair 2); harvest Cursor/Copilot/README rules in `/canon:init` (Pair 4); explicit per-agent stance declarations (cross-cutting #5).

---

## "Canon is already better — do NOT touch" verdicts

1. **The `write_review` structured artifact** (reviewer lines 519-565) beats both stock flat-JSON and stock markdown output — it feeds drift analytics, craft store, renderer, and confidence tiers. Do not regress to a flat finding list.
2. **Detect/fix separation** (reviewer flags, engineer fixes under `leave-touched-files-better`). Stock `simplify` collapses them into an actuator; Canon's split preserves cold review, the journal, and the fix-iteration loop. Do not merge.
3. **Scope discipline on cleanup** — `leave-touched-files-better`'s "only files already being modified" (principle line 25) independently matches stock simplify's "skip fixes outside the diff." Convergent; already right.
4. **Diff-driven, contract-scoped doc maintenance** (scribe) + **convention auto-detection** (`/canon:init` Step 5) + **the scribe anti-bloat exclusion list** (lines 137-158) all exceed stock `init`'s one-shot generic writer. Do not collapse to one-shot.
5. **Externalized security taxonomy** (`references/security-checklist.md`) over stock's inlined category list. Keep it referenced, don't inline.
6. **Plan-aware checks** (security Step 4.5 planned-controls; reviewer Stage 4 drift; tester risk-coverage cross-check) have no stock analog — they exist because Canon has a DESIGN.md upstream. Pure Canon advantage.
7. **Mechanical user-observable-AC detection** (tester lines 72-78) — stock `run` relies on agent judgment to decide what to drive; Canon mechanically identifies observable ACs from the runbook. Keep the trigger.

---

## Verified-in-repo vs. inferred (audit trail)

- **Verified-in-repo** (read this session): all 5 stock prompts; `agents/reviewer.md`, `agents/security.md`, `agents/scribe.md`, `agents/tester.md`; `skills/canon/commands/init.md`; `principles/strong-opinions/simplicity-first.md`, `leave-touched-files-better.md`; `principles/conventions/read-only-tool-reuse-over-reimplementation.md`; verify-gate text at root `CLAUDE.md:386` and `:145`.
- **Inferred** (not directly read this session): the *contents* of `references/security-checklist.md` (referenced, not opened — so "Canon lacks the stock precedents in concrete form" is inferred from the agent prose, not confirmed against the checklist body); the *current shipped* state of the stock skills (assumed == captured copies); whether `/run-skill-generator` has any Canon analog (assumed none). Before implementing lesson #2, read `references/security-checklist.md` to confirm overlap and avoid duplicating precedents already present.
