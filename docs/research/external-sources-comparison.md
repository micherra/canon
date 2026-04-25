# External Sources vs. Canon — Combined Comparison

**Date:** 2026-04-20
**Scope:** Ideas Canon could learn from four external sources, classified against Canon's architecture and filtered for fit with Canon's ethos (orchestrator-dispatcher, local-first, structured artifacts, principles as prescriptive rules).

## Sources reviewed

- **CodeFlow** (`github.com/braedonsaunders/codeflow`) — single-file browser-based codebase visualizer. Overlap axis: codebase-analysis primitives.
- **agentkb** (`github.com/isaac-flath/agentkb`) — local-first, file-backed memory system for coding agents. Four stores (Wiki / Chats / Communications / Skills) with per-store retrieval.
- **SpecStory** (`specstory.com`) — commercial chat-capture + spec-driven-development tool. Framing: "intent is the new source code."
- **Karpathy's LLM Wiki gist** (`gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`) — architectural pattern for an LLM-maintained personal wiki as an alternative to RAG. Memorable framing: *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."*
- **forrestchang/andrej-karpathy-skills** (`github.com/forrestchang/andrej-karpathy-skills`) — four behavioral rules distilled from a Karpathy tweet on coding-agent failure modes, packaged as a Claude Code plugin / per-project `CLAUDE.md` snippet / Cursor `.mdc` rule. Distinct from the LLM Wiki gist above.
- **Gas Town** (`github.com/gastownhall/gastown`) — Go-based multi-agent orchestration system coordinating 20-30 cross-tool agents (Claude Code, Copilot, Codex, Gemini) via git-worktree-backed persistent state. Distinctive subsystems: a Bors-style bisecting merge queue (Refinery), three-tier agent-health watchdogs (Witness / Deacon / Dogs), a git-backed issue tracker (beads) with dependency-graph readiness filtering, federated cross-instance networking (Wasteland), and predecessor-session context recovery (Seance).
- **Gas City** (`github.com/gastownhall/gascity`) — Go SDK extracted from Gas Town that converts hardwired roles into pure TOML configuration so alternative orchestration packs (Gas Town, Ralph, Claude Code Agent Teams) can be built atop the same infrastructure. Distinctive framing: nine irreducible primitives (Agent Protocol / Task Store / Event Bus / Config / Prompt Templates plus four derived layers), progressive capability levels 0-8 unlocked by config presence, multi-runtime providers (tmux / subprocess / Kubernetes / ACP), and three explicit design tests — *Zero Framework Cognition* (no judgment calls in framework code), *Bitter Lesson* (every primitive must become more useful as models improve), and *Nondeterministic Idempotence* (convergence via persistent state plus multiple independent observers).
- **Wasteland** (`github.com/gastownhall/wasteland`) — federated work-coordination layer for Gas Town communities, built on DoltHub (versioned SQL). Each "rig" maintains a sovereign fork of a shared commons database; rigs synchronize wanted-boards, claim/completion lifecycles, and GPG-signed reputation stamps (quality / reliability / impact / skill tags) across communities. Three equally-capable interfaces (CLI, TUI, embedded web) over a shared SDK; PR-mode vs wild-west-mode for review-gated vs direct-push workflows.
- **beads** (`github.com/gastownhall/beads`) — standalone CLI issue tracker for AI agents, backed by Dolt (versioned SQL with cell-level merge). Used as Gas Town's task store but distributed independently. Distinctive ideas: hash-based collision-free IDs (`bd-a1b2`) for multi-agent concurrency, atomic claim (`bd update --claim`), auto-ready dependency-graph queue (`bd ready`), hierarchical IDs for epic decomposition (`bd-a3f8.1.1`), semantic compaction of closed tasks ("memory decay"), typed inter-task graph links (`relates_to`, `duplicates`, `supersedes`, `replies_to`), an agent-to-agent messaging issue type with threading, stealth/contributor modes for non-tracked or fork workflows, and a "land the plane" push-or-fail discipline with `(bd-abc)` issue-ID commit-message convention enabling `bd doctor` orphan detection.

Two sources reviewed and dropped from the shortlist: **pi-mono** (pi.dev) operates a layer below Canon (agent runtime, CLI, UI), and **codeflow's browser-shell ideas** are architecturally incompatible.

---

## Worth adopting

Grouped by bounded context. Each item cites its source and fits within Canon's existing model without touching the orchestrator-dispatcher contract.

### Code intelligence & diagnostics

**1. Composite health score for human-readable reports** *(CodeFlow)*

CodeFlow collapses dead code %, cycles, coupling, and security issues into an A–F grade. Canon has every ingredient (compliance %, cycle count, hub density, drift trends) but no single summary signal. A composite score inside `get_drift_report` gives humans a fast status read and the learner a durable metric to track.

*Fit:* slots into `get_drift_report` as an aggregated output field. Diagnostics bounded context.

**2. Design-pattern and anti-pattern labels as KG annotations** *(CodeFlow)*

Canon's KG already exposes hub scores, cycles, and layer violations; it doesn't label them as named patterns. Adding a vocabulary (God Object, Singleton, Factory, Observer) lets principles reference patterns and lets the architect cite them in design briefs. Most signals already computed — what's missing is the labeling pass.

*Fit:* extends KG edge/node metadata. Aligns with `mcp-intelligence-roadmap.md` P3.

**3. Duplicate-block detection** *(CodeFlow)*

Canon flags dead code but not near-duplicates. AST-shingling over normalized nodes gives the architect a wave-assignment signal (duplicates refactor together), the reviewer a copy-paste-drift signal, and the learner a "promote to utility" signal.

*Fit:* new KG signal. Moderate build cost; concrete payoff across three roles.

**4. Churn/blast-radius overlays in `codebase_graph`** *(CodeFlow)*

The MCP app has a compliance overlay; adding churn and blast-radius colorings gives reviewers two more lenses on the same graph. Data already exists (hotspot scoring + blast-radius API).

*Fit:* pure visualization layer over existing KG data.

**5. `canon:report` — human-readable state-of-the-codebase summary** *(CodeFlow)*

Canon's artifacts are workflow-scoped. A one-shot Markdown report — compliance %, top hotspots, cycles, recent drift, wave-in-progress — makes Canon legible to engineering leaders who don't run flows. Bundled with `/canon:check`, the guide agent produces it.

*Fit:* non-flow entry point (shape Canon already has). Orchestrator untouched.

**6. Static security heuristic pre-filter for `security-audit`** *(CodeFlow)*

The flow is principle-driven today. Cheap regex checks (`eval`, SQL concatenation, common secret formats) give the security agent a pre-filtered candidate list instead of starting from scratch. Additive context, not a replacement for agent judgment.

*Fit:* lightweight module in `mcp-server/src/features/diagnostics/`. Output injected into the security agent's context.

### Compounding knowledge & artifact hygiene

**7. Consolidation workflow — `canon:distill`** *(agentkb)*

agentkb's standout move is the chat → wiki consolidation step: an agent reads recent sessions and synthesizes durable insights into permanent entries. Canon has the pieces (`canon-learner` reads drift, `canon-writer` authors principles) but no regular loop that sweeps completed workspaces for crystallizable patterns. A `canon:distill` command (or a post-flow hook) that hands recent `progress.md` + drift events to the learner for principle-candidate extraction closes this gap.

*Fit:* slots into the existing learner/writer pair. Orchestrator untouched.

**8. Repo-level `.canon/log.md` with parseable prefix** *(Karpathy)*

Canon has per-workspace `progress.md` but no global timeline of ingests, flow completions, principle additions, and lint passes. Karpathy's `## [YYYY-MM-DD] type | title` prefix is grep-parseable in one line; appending to a repo-level `.canon/log.md` gives the learner, guide, and humans a single project timeline without scanning each workspace.

*Fit:* additive write at `complete_flow` and principle events. Orchestrator change is a single append.

**9. Wiki-lint pass over Canon's own artifacts** *(Karpathy)*

Canon lints code against principles but not its own meta-layer. A lint pass over contradictions between `CLAUDE.md`s, orphan principles with no usages, stale plans referencing renamed files, and principles lacking backing examples applies Karpathy's wiki-health operation to Canon itself.

*Fit:* reuses scribe and learner; surfaces via `get_artifact_drift` (or an extension to `get_drift_report`). Diagnostics bounded context.

**10. Compounding exploration — file `explore` outputs into a durable artifact** *(Karpathy)*

Today `explore` produces a research brief that lives inside the workspace and doesn't accrete anywhere. A scribe convention that promotes notable findings into a project-level `docs/notes/` (or equivalent) — cross-referenced by topic — makes Canon's explorations compound over time. Pairs with #7 operationally; implement together.

*Fit:* additive scribe responsibility. No orchestrator change.

### Observability

**11. Query traceability log for KG and semantic search** *(agentkb)*

agentkb logs every query, expansion, and ranking decision. Canon logs agent-level metrics but not individual KG or `semantic_search` calls. A lightweight JSONL query log (mirroring the drift store) lets Canon evaluate retrieval quality and tune ranking without guessing — useful as the KG grows.

*Fit:* additive to `mcp-server/src/features/diagnostics/`. Orchestrator untouched.

### Flow inputs

**12. Transcript-to-spec extractor — reshapes roadmap Item 28** *(SpecStory)*

SpecStory's "chats as durable intent" collides cleanly with Canon roadmap **Item 28 (Idea-to-Spec Flow)**. Canon already records agent transcripts via `get_transcript`; what's missing is an extractor that mines a conversational `explore` or `chat` session and emits a structured spec artifact usable as input to `feature`/`epic`. This validates the item — transcripts are the right raw material, and the spec output format matters. The transcript is *input* to structured synthesis, not a first-class artifact on its own.

*Fit:* reshapes Item 28 rather than adding new scope. New artifact template + spec-synthesis role.

### Flow execution

**13. Bisecting merge queue for completed waves — `canon-shipper` Refinery mode** *(Gas Town)*

Gas Town's Refinery is a Bors-style merge queue that batches completed agent work and bisects to isolate integration breakage when the batch fails CI. Canon's epic flow merges waves sequentially; an integration failure today requires re-running the failing wave or manually bisecting suspects. A Refinery-style mode in `canon-shipper` — queue completed waves, attempt batched merge, bisect on failure to find the offending wave, quarantine and retry — gives Canon faster integration on multi-wave epics without changing the orchestrator contract. Pure shipper-state addition.

*Fit:* extends `canon-shipper` for epic-flow ship states. Worktree merge primitives Canon already has cover the mechanics.

### Framework self-discipline

**14. Bitter Lesson + Zero Framework Cognition test as an explicit gate for new Canon features** *(Gas City)*

Gas City filters every proposed primitive through two questions: does it become *more* useful as models improve (Bitter Lesson), and does any line require a judgment call inside framework code rather than a prompt (Zero Framework Cognition)? Canon already follows both implicitly — the orchestrator is a pure dispatcher and principle authoring is human-owned — but neither is written down as a rubric Canon applies to *itself*. Adding a short checklist to the principle-writing template and to the roadmap-item template (e.g., "fails if a heuristic in MCP-server code makes the call an agent prompt could make instead") gives `canon-writer`, `canon-architect`, and reviewers of `mcp-intelligence-roadmap.md` a reusable filter. Lightweight, additive, no new code path; pure documentation surface.

*Fit:* extends `templates/` and the roadmap document. Aligns with Canon's existing "orchestrator stays a pure dispatcher" contract from `CLAUDE.md`.

### Federated work coordination

**Wasteland — no novel items; every distinctive idea conflicts with Canon's local-first, structured-artifact ethos.**

Wasteland's wanted-board lifecycle (open → claimed → in_review → completed) duplicates Canon's flow state machine (`drive_flow` plus the `feature` / `epic` flow definitions in `flows/`). Its skill-tagged completion stamps with quality / reliability / impact ratings overlap structurally with `record_agent_metrics` and the JSONL drift store in `mcp-server/src/features/diagnostics/`, but Wasteland's stamps are designed as portable cross-community reputation tokens — Canon's metrics are local-only on purpose. Everything else (sovereign-fork federation, DoltHub commons, GPG-signed cross-instance attestations, triple-interface SDK, PR-mode vs wild-west-mode toggle) lands squarely in the sharing / cross-tool / cross-machine non-fit theme. Net adoption candidates: zero. The federated cross-instance non-fit row already covered Wasteland in the Gas Town context; this entry confirms there is nothing salvageable when Wasteland is examined on its own terms.

### Issue-tracker substrates

**beads — no novel items; every distinctive idea either duplicates existing Canon machinery or lands in the local-first / pure-dispatcher non-fit themes.**

beads is a CLI issue tracker; Canon's equivalent is the orchestration harness's own task layer (`board.json` plus per-workspace `progress.md` and the wave/state machinery in `mcp-server/src/features/orchestration/`). Mapping beads' distinctive ideas:

| beads idea | Canon equivalent / classification |
|---|---|
| Hash-based collision-free IDs (`bd-a1b2`) for multi-agent concurrency | Partial overlap. Canon's worktree-isolation model (`isolation: "worktree"` per agent spawn, `CLAUDE.md` "Isolation requirement") avoids the cross-writer collisions hash IDs solve. Wave-task IDs already exist in `board.json`; ID format is not worth adopting standalone. |
| Atomic claim (`bd update --claim`) | Duplicate. Canon's wave runner assigns tasks to agents via `drive_flow` SpawnRequests; race conditions are precluded by the orchestrator-as-single-writer contract, not a DB-level claim. |
| Auto-ready dependency-graph queue (`bd ready`) | Duplicate. The wave planner in `mcp-server/src/features/orchestration/` already orders tasks by dependency and emits ready waves; there is no value in a parallel queryable view. |
| Hierarchical IDs for epic decomposition (`bd-a3f8.1.1`) | Duplicate. The `epic` flow already decomposes into waves and tasks; the ID format is cosmetic. |
| Semantic compaction of closed tasks ("memory decay") | Partial overlap with **Item 7 (`canon:distill`)**. Canon's distillation operates on durable artifacts (progress, drift events) and crystallizes principles; compacting raw closed-task rows is the same shape applied to a substrate Canon doesn't keep. Already covered by item 7. |
| Typed inter-task graph links (`supersedes`, `duplicates`, `replies_to`, `relates_to`) | Partial overlap. Canon's KG already supports typed edges between code nodes; applying them to *artifacts* is conceivable, but Canon's artifacts are workflow-scoped and short-lived — there is no graph of long-lived tasks for these relations to live in. |
| Agent-to-agent messaging issue type with threading | Non-fit. Already covered by the Gas Town / Gas City "mailbox / nudge" non-fit rows — agents do not communicate peer-to-peer; the orchestrator dispatches and aggregates. |
| Stealth mode (no committed files) and contributor mode (separate planning repo) | Non-fit. Canon's principles, `board.json`, and progress travel with the project repo on purpose so they govern the code they ship with. Side-channeling task state breaks the compliance story (same reasoning as the agentkb per-store-independent-repos non-fit row). |
| "Land the plane" push-or-fail discipline | Duplicate. `canon-shipper` plus the flow contract already enforce push as a state transition with verification, not a courtesy. |
| `(bd-abc)` issue-ID commit-message convention with `bd doctor` orphan detection | Non-fit on its own terms. The convention presupposes a beads-style external task store; without that store (rejected above as a Gas Town non-fit), there is nothing for the IDs to reference. Canon already links commits to flows via worktree branch names. |

Net adoption candidates: zero. beads operates one layer below Canon — it is a task-tracking substrate, where Canon owns the *orchestration layer above it*. Its distinctive ideas either solve problems Canon's worktree + state-machine model already precludes (hash IDs, atomic claim) or assume a substrate Canon deliberately rejects (parallel issue tracker, side-channel task state, agent messaging).

### Behavioral-rule distillations

**forrestchang/andrej-karpathy-skills — no novel items; full duplicate of existing principles.**

The repo packages four rules from a Karpathy tweet on coding-agent failure modes: *Think Before Coding* (surface assumptions, don't hide confusion), *Simplicity First* (minimum code, nothing speculative), *Surgical Changes* (touch only what you must; don't reformat or refactor adjacent untouched code), and *Goal-Driven Execution* (turn vague requests into verifiable success criteria with a verify loop). Each maps to machinery Canon already ships:

| Karpathy-skills rule | Canon equivalent |
|---|---|
| Think Before Coding | Flow state machine enforces research → architect → implement ordering; HITL breakpoints surface assumptions before writing code. No single principle file, but `strong-opinions/patterns-need-justification.md` covers the "don't add abstractions on a hunch" half. |
| Simplicity First | `principles/strong-opinions/simplicity-first.md` — direct duplicate, same name. |
| Surgical Changes | `principles/rules/refactoring-integrity.md` (no unintended modification of untouched code) plus `strong-opinions/leave-touched-files-better.md` (scoped cleanup discipline). |
| Goal-Driven Execution | Flow contract — plans declare acceptance criteria; `canon-tester` and `canon-reviewer` verify against them; `drive_flow` status transitions enforce the verify loop. |

Nothing survives as an adoption candidate. The repo is a useful *validation signal* that Canon's existing principles target real, widely-observed failure modes — but the ideas are already encoded, with severity levels and drift tracking the external repo lacks.

---

## Non-fits

Consolidated across all sources. These conflict with Canon's ethos and should not be adopted.

| Idea | Source | Why it conflicts |
|---|---|---|
| Browser-only / zero-install / CDN-hosted | CodeFlow | Canon is an MCP server with stateful local databases and worktrees. "Just one HTML file" is architecturally incompatible. |
| Shareable analysis URLs | CodeFlow | Canon has no server-hosted state. Workspace resume from `board.json` covers "pick up where you left off" natively. |
| Code ownership via `git blame` | CodeFlow | Deliberately deferred (`codebase-intelligence-roadmap.md:14`). Noisy, expensive, low-signal for AI agents. Adopting it regresses the roadmap decision. |
| Regex-based multi-language extraction (30+ languages) | CodeFlow | Canon prefers AST-based, narrower-but-accurate extraction. Regex noise degrades KG reliability for agents treating it as ground truth. |
| Human-facing interactive UI as the primary surface | CodeFlow | Canon's primary surface is the agent pipeline. MCP apps are secondary visualization. |
| Treating raw chat transcripts as primary artifacts | SpecStory | Canon's artifacts are structured (plans, reviews, progress, principles). Raw dialogue is secondary data; structured extractions are what agents and humans consume. Transcripts serve as *input* (item 12), not as durable output. |
| Cross-workspace / cross-tool transcript aggregation | SpecStory, agentkb | Exposes raw dialogue as a first-class cross-project resource. Canon's structured artifacts already capture decisions; making transcripts searchable adds noise on top of existing signal and conflicts with "structured over raw." |
| Cross-tool IDE chat aggregation (Cursor / Copilot / Codex / Claude Code) | SpecStory | Canon lives inside Claude Code. Cross-tool SaaS aggregation is incompatible with Canon's local-first skill-scoped model. |
| Cross-machine sync of agent state or chats | SpecStory | Canon state is `.canon/` + worktrees, local by design. Cloud sync inverts the threat model. |
| Public chat / session sharing as a social artifact | SpecStory, pi-mono | Transcripts can leak credentials, internal code, and unreleased decisions. No public-sharing affordance is appropriate for Canon. |
| Open-source session export (Hugging Face, etc.) | pi-mono | Same as above — Canon has no external-publishing pipeline and the threat model makes one a liability, not an asset. |
| Per-store independent git repos for artifact sync | agentkb | Canon's artifacts live in the project repo on purpose — principles travel with the code they govern. Splitting them fragments the compliance story. |
| Wiki-as-substrate replacing Canon's principle / KG layer | Karpathy | Karpathy's wiki is an evolving free-form corpus owned by the LLM; Canon's principles are prescriptive, drift-tracked, compliance-scored. A wiki-maintainer *flow* is additive; wiki-as-substrate loses severity levels, compliance machinery, and reviewer enforcement. |
| "LLM writes everything, human only curates sources" | Karpathy | Canon's principles are shared team infrastructure; humans author them to retain accountability. `canon-writer` drafts; humans own. |
| Obsidian (or any second tool) as the reading surface | Karpathy | Canon's surfaces are Claude Code, MCP apps, and the repo file tree. A second reading app adds coupling without replacing anything Canon ships. |
| Spec-Driven Development as the only entry point | SpecStory | Canon's flow library spans fast-path → epic on purpose. Forcing an upfront spec on every task regresses fast-path's reason for existing. Item 28 adds SDD as an *option*, not a default. |
| pi-mono agent runtime, CLI, TUI, web, Slack, GPU deploy | pi-mono | Canon runs inside Claude Code as a dispatcher; these are a layer below (or orthogonal to) Canon's scope. |
| Unified multi-provider LLM client | pi-mono | Provider abstraction is the host's responsibility, not the orchestrator's. |
| Behavioral rules as a `CLAUDE.md` snippet / plugin / Cursor `.mdc` | forrestchang/andrej-karpathy-skills | Canon encodes behavioral guidance as prescriptive principles with severity levels, drift tracking, and compliance scoring. Free-form `CLAUDE.md` rules have no enforcement surface, no drift signal, and no reviewer citation — they are advisory text, not infrastructure. |
| Shipping coding-agent guidance as a cross-tool plugin (Claude Code + Cursor) | forrestchang/andrej-karpathy-skills | Canon is a Claude Code skill by design; cross-IDE distribution is out of scope (same reasoning as the SpecStory cross-tool row). |
| Cross-tool agent coordination (Claude Code + Copilot + Codex + Gemini concurrently) | Gas Town | Canon is a Claude Code skill; multi-provider runtime is the host's responsibility. Same reasoning as SpecStory cross-tool and pi-mono multi-provider rows. |
| Federated cross-instance networking (sovereign forks of a shared commons DB) | Wasteland, Gas Town | Cross-machine sync of agent state inverts Canon's local-first threat model. Same reasoning as SpecStory cross-machine sync. |
| GPG-signed cross-community reputation stamps (quality / reliability / impact / skill) | Wasteland | Canon has no reputation layer because agents are not cross-community actors. `record_agent_metrics` already captures the equivalent signals locally; cryptographically-signed portable attestations only matter when state crosses trust boundaries, which Canon deliberately avoids. |
| DoltHub versioned-SQL as the durable substrate for agent state | Wasteland | Canon's substrates (`board.json`, principle store, drift JSONL, KG SQLite) are typed per concern and live in the project repo. A versioned-SQL commons is built around federation; without federation it adds operational weight without payoff. |
| Triple-interface SDK (CLI + TUI + embedded web) over a single shared client | Wasteland | Canon's primary surface is the agent pipeline inside Claude Code; MCP apps are secondary visualization. Maintaining three equally-capable user-facing interfaces is a layer below Canon's scope, same reasoning as the pi-mono runtime row. |
| Workflow-mode toggle (PR mode vs wild-west mode) on the work store | Wasteland | Canon's flow library spans fast-path → epic precisely so review-gated vs direct-push is a flow-selection decision, not a global mode flag. A repo-wide toggle would collapse signal that the flow tier already encodes. |
| Agent-to-agent comms via mailbox / nudge channels | Gas Town | Canon's orchestrator dispatches and aggregates results; agents do not communicate peer-to-peer. Adding an inter-agent channel breaks the pure-dispatcher contract. |
| Three-tier external watchdog daemons monitoring agent health | Gas Town | Canon agents run as Claude Code spawns inside a single session; health monitoring is the host's job. A separate watchdog tier is a runtime-layer concern below Canon's scope (same reasoning as the pi-mono runtime row). |
| Git-backed parallel issue tracker as primary task store | Gas Town | Canon's task state lives in `board.json` + workspace artifacts on purpose — they travel with the flow and feed drift/compliance. A second issue tracker fragments the source of truth. |
| Predecessor-session transcript query (Seance) as a primary recovery surface | Gas Town | Canon recovers via `board.json` resume + structured artifacts, not raw prior-session transcripts. Same reasoning as the SpecStory raw-transcript row. |
| Web dashboard as a primary monitoring surface for live agent fleets | Gas Town | Canon's primary surface is the agent pipeline; MCP apps are secondary visualization, not a fleet-ops console. Aligns with the CodeFlow "interactive UI as primary surface" non-fit. |
| 20-30 concurrent agents as a target operating mode | Gas Town | Canon's epic flow runs bounded waves sized to dependency structure, not headcount. Optimizing for fleet scale changes the contract from "right-sized waves" to "keep N agents busy." |
| Multi-runtime provider abstraction (tmux / subprocess / Kubernetes / ACP) | Gas City | Canon agents are Claude Code spawns inside a single host session; runtime choice is the host's responsibility. A provider abstraction is a layer below Canon's scope (same reasoning as the pi-mono runtime row). |
| Role packs as swappable configuration (Gas Town / Ralph / Agent Teams from one SDK) | Gas City | Canon's specialist agents are deliberately fixed — each maps to a state-machine role and carries scoped responsibilities encoded in the flow contract. Swappable role packs would dilute drift tracking and reviewer enforcement, which depend on stable agent identities. |
| "No status files — query live state directly" | Gas City | Canon's `board.json`, `progress.md`, and workspace artifacts are durable status by design — they enable resume across sessions, drive drift tracking, and feed compliance scoring. Live-state-only inverts Canon's structured-artifact ethos. |
| Agent-to-agent messaging via mailbox (Mail) and prompt-injection (Nudge) | Gas City | Same reasoning as the Gas Town mailbox/nudge row — Canon's orchestrator dispatches and aggregates; agents do not communicate peer-to-peer. |
| Beads as the universal persistence substrate for all domain state | Gas City | Canon already has typed substrates per concern (`board.json` for flow state, principle store, drift JSONL, KG SQLite). Collapsing them into a single beads-style store loses the schema discipline reviewers and the learner depend on. |
| Progressive capability levels 0-8 unlocked by config presence | Gas City | Canon already differentiates capability via flow tier (fast-path → epic) and per-flow state composition. A separate level system would duplicate flow selection without adding signal. |
| Go SDK distribution model (`pkg/` exports, semantic versioning, library consumption) | Gas City | Canon is a Claude Code skill plus an MCP server, not a library other Go programs link against. SDK packaging is orthogonal to Canon's distribution surface. |
| Controller/supervisor convergence loop as the core execution model | Gas City | Canon's execution model is a state machine driven by `drive_flow`; convergence-via-reconciliation is a different runtime contract that would replace, not extend, the current loop. |
| Stealth-mode task state (uncommitted, side-channeled outside the project repo) | beads | Canon's `board.json`, `progress.md`, and principles are checked into the project repo on purpose so they govern the code they ship with. A side-channel task store fragments the compliance story (same reasoning as the agentkb per-store-independent-repos row). |
| Contributor-mode task routing to a separate planning repo for forks | beads | Canon flows operate against the working tree where the orchestrator runs; routing planning artifacts to a different repo on fork-vs-maintainer detection adds a runtime concern below Canon's scope and conflicts with "principles travel with the code." |
| Dolt-versioned-SQL as the durable substrate for tasks | beads | Canon's substrates are typed per concern (`board.json`, principle store, drift JSONL, KG SQLite) — the same critique as the Wasteland DoltHub-substrate row. A versioned-SQL store is built around cell-level merge for distributed writers Canon does not have. |
| Semantic compaction operating on raw closed-task rows | beads | Canon's compounding-knowledge layer (Item 7) operates on durable structured artifacts; compacting raw rows from a substrate Canon does not keep is a non-starter. The useful shape is already adopted as `canon:distill`. |
| `(<issue-id>)` commit-message convention as orphan-detection mechanism | beads | The convention presupposes a beads-style external task tracker for the IDs to reference. Canon links commits to flows via worktree branch names (`agent-<sha>` paths from `git worktree`), and orphan detection happens at the workspace level via `init_workspace` resume. Adopting the convention without the tracker has nothing to point at. |

---

## Takeaway

Fourteen ideas across eight sources fit Canon without touching the orchestrator-dispatcher contract. Six strengthen **code intelligence and diagnostics** (health score, pattern labels, duplicate detection, visualization overlays, one-shot report, security pre-filter). Four extend **compounding knowledge and artifact hygiene** (distillation loop, repo-level log, wiki-lint over Canon's own artifacts, compounding exploration). One adds **retrieval observability** (KG query log). One reshapes **flow inputs** (transcript-to-spec for roadmap Item 28). One sharpens **flow execution** (bisecting merge queue for shipper). One adds **framework self-discipline** (Bitter Lesson + ZFC test as a rubric for new Canon features). Five sources — forrestchang/andrej-karpathy-skills, Gas Town, Gas City, Wasteland, and beads — contributed zero, one, one, zero, and zero principle-level adoption candidates respectively; the Karpathy rules duplicate `simplicity-first`, `refactoring-integrity`, `leave-touched-files-better`, and flow-level structural enforcement, Gas Town's orchestration concepts (worktrees, persistent state, structured artifacts, dispatcher coordination) mirror architecture Canon already ships with only Refinery's merge-queue surviving, Gas City's nine primitives are Canon's existing infrastructure under different names — only its self-applied Bitter Lesson / Zero Framework Cognition rubric was novel as a written-down filter — Wasteland's wanted-board lifecycle and skill-tagged completion stamps duplicate Canon's flow state machine and `record_agent_metrics` while every other Wasteland idea (sovereign-fork federation, DoltHub commons, GPG-signed cross-community attestations, triple-interface SDK) lands in the sharing / cross-machine non-fit theme, and beads is a task-tracking substrate one layer below Canon — its distinctive ideas (hash IDs, atomic claim, auto-ready queue, hierarchical decomposition, `(bd-abc)` commit convention) either solve problems Canon's worktree + state-machine model already precludes or presuppose a parallel issue tracker Canon deliberately rejects in favor of `board.json` + workspace artifacts.

The largest consistent non-fit theme is **sharing and cross-tool aggregation** — public session exports, cross-IDE chat sync, cross-machine state, shareable URLs, federated multi-instance networks, and multi-provider agent runtimes. Canon is deliberately local-first, Claude-Code-scoped, and structured; raw-dialogue ideas either fail the threat model or conflict with "structured artifacts over raw transcripts." Likewise, anything that would replace Canon's prescriptive principle/KG layer with an evolving free-form wiki — or with free-form `CLAUDE.md` rules that lack severity, drift, and compliance scoring — is out, as is any move toward swappable role packs, multi-runtime providers, or live-state-only execution that would dissolve Canon's typed substrates and stable agent identities. Canon loses the enforcement machinery that makes principles useful.
