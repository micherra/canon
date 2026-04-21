# External Sources vs. Canon — Combined Comparison

**Date:** 2026-04-20
**Scope:** Ideas Canon could learn from four external sources, classified against Canon's architecture and filtered for fit with Canon's ethos (orchestrator-dispatcher, local-first, structured artifacts, principles as prescriptive rules).

## Sources reviewed

- **CodeFlow** (`github.com/braedonsaunders/codeflow`) — single-file browser-based codebase visualizer. Overlap axis: codebase-analysis primitives.
- **agentkb** (`github.com/isaac-flath/agentkb`) — local-first, file-backed memory system for coding agents. Four stores (Wiki / Chats / Communications / Skills) with per-store retrieval.
- **SpecStory** (`specstory.com`) — commercial chat-capture + spec-driven-development tool. Framing: "intent is the new source code."
- **Karpathy's LLM Wiki gist** (`gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`) — architectural pattern for an LLM-maintained personal wiki as an alternative to RAG. Memorable framing: *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."*
- **forrestchang/andrej-karpathy-skills** (`github.com/forrestchang/andrej-karpathy-skills`) — four behavioral rules distilled from a Karpathy tweet on coding-agent failure modes, packaged as a Claude Code plugin / per-project `CLAUDE.md` snippet / Cursor `.mdc` rule. Distinct from the LLM Wiki gist above.

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

---

## Takeaway

Twelve ideas across four sources fit Canon without touching the orchestrator-dispatcher contract. Six strengthen **code intelligence and diagnostics** (health score, pattern labels, duplicate detection, visualization overlays, one-shot report, security pre-filter). Four extend **compounding knowledge and artifact hygiene** (distillation loop, repo-level log, wiki-lint over Canon's own artifacts, compounding exploration). One adds **retrieval observability** (KG query log). One reshapes **flow inputs** (transcript-to-spec for roadmap Item 28). A fifth source — forrestchang/andrej-karpathy-skills — contributed zero adoption candidates; its four rules duplicate `simplicity-first`, `refactoring-integrity`, `leave-touched-files-better`, and flow-level structural enforcement that Canon already ships.

The largest consistent non-fit theme is **sharing and cross-tool aggregation** — public session exports, cross-IDE chat sync, cross-machine state, shareable URLs. Canon is deliberately local-first and structured; raw-dialogue ideas either fail the threat model or conflict with "structured artifacts over raw transcripts." Likewise, anything that would replace Canon's prescriptive principle/KG layer with an evolving free-form wiki — or with free-form `CLAUDE.md` rules that lack severity, drift, and compliance scoring — is out. Canon loses the enforcement machinery that makes principles useful.
