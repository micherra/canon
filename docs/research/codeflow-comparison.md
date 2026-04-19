# CodeFlow vs. Canon — Comparison

**Source:** https://github.com/braedonsaunders/codeflow
**Date:** 2026-04-19
**Purpose:** Catalog ideas from CodeFlow and classify whether Canon already covers them, partially overlaps, or has no equivalent. Assess fit of novel ideas against Canon's orchestrator-dispatcher model.

---

## What CodeFlow Is

CodeFlow is a **single-file browser-based codebase visualizer** (one `index.html`, React + D3 + Babel from CDNs, no backend, no install). You paste a GitHub URL or drop local files, and it produces an interactive dependency graph with overlays for blast radius, code ownership, security issues, pattern detection, health score, activity heatmap, and PR impact. It is an end-user analysis tool — not an agent orchestration framework.

Architecturally, CodeFlow and Canon are orthogonal: CodeFlow is a read-only visualizer run by humans; Canon is an agent harness that drives state-machine flows. But they overlap on **codebase analysis primitives** — both compute dependency graphs, blast radius, and review/PR impact. That is the only productive axis of comparison.

---

## Idea Inventory

| # | CodeFlow idea | Classification | Canon equivalent / gap |
|---|---|---|---|
| 1 | Interactive dependency graph (click, drag, zoom) | **Duplicate** | `codebase_graph` MCP app with compliance overlay (`reference/canon-reference.md:63`). Canon's is richer — KG-backed with cycles, hubs, layers. |
| 2 | Blast radius ("what breaks if I change this?") | **Duplicate** | `get_file_context` and `graph_query` both expose blast radius (`reference/canon-reference.md:67-68`); `show_pr_impact` overlays it on PRs. |
| 3 | Code ownership via `git blame` (top contributors per file) | **Duplicate** (explicitly rejected) | `codebase-intelligence-roadmap.md:14` — "Ownership intelligence: Deferred. `git blame` is expensive, low signal for AI agents, useless in single-developer projects." |
| 4 | Security scanner: hardcoded secrets, SQLi, `eval()`, debug statements | **Partial overlap** | Canon has a `security-audit` flow and `pre-commit-check.sh` hook for secrets (`reference/canon-reference.md:101`), but no static-heuristic scanner for injection/`eval`/debug. Principle-grounded review covers similar ground in a different frame. |
| 5 | Pattern detection: Singleton, Factory, Observer, React hooks | **Novel** | Canon has no design-pattern recognizer. Closest is principle matching, which is prescriptive (rules to follow) rather than descriptive (patterns present). |
| 6 | Anti-pattern detection: God Objects, high coupling | **Partial overlap** | Canon KG already exposes hub scores (`is_hub`, `in_degree`/`out_degree`) and cycles (`mcp-intelligence-roadmap.md:83`). A "God Object" is just a high-degree hub. Canon has the signal but doesn't label it as an anti-pattern for user consumption. |
| 7 | Health score (A–F grade) — composite of dead code %, cycles, coupling, security | **Partial overlap** | Canon's `get_compliance` and `get_drift_report` show per-principle stats and weekly trends (`reference/canon-reference.md:66`), but there is no single composite "grade." Canon also already computes cycles, blast radius, and compliance — the ingredients are there, just not aggregated into one number. |
| 8 | Activity heatmap (color files by commit frequency) | **Duplicate** | `codebase-intelligence-roadmap.md:28-49` — hotspot scoring (churn × complexity with recency decay) is planned/in progress. Goes beyond CodeFlow by weighting by complexity and recency. Surfaces via `get_file_context`, `show_pr_impact`, and context injection. |
| 9 | PR impact analysis (paste PR URL → blast radius of changes) | **Duplicate** | `show_pr_impact` MCP app (`reference/canon-reference.md:63`) — PR blast radius, hotspots, violations, dependency subgraph. Richer than CodeFlow's. |
| 10 | Local file analysis (drag-and-drop, in-browser, privacy-first) | **Non-fit** | Canon runs as a Claude Code skill on the developer's machine with full filesystem access. "Privacy-first browser sandbox" is irrelevant to Canon's model. |
| 11 | Zero-install / single HTML file / CDN deps | **Non-fit** | Canon is an MCP server + agent definitions + hooks. Not a deployment model Canon can or should adopt. |
| 12 | Export formats: JSON, Markdown, plain text, SVG graph, raw JSON | **Partial overlap** | Canon's artifacts (`plans/`, `REVIEW.md`, test reports) are structured markdown + JSON sidecars. No SVG graph export. No "share this analysis as a report" affordance for humans outside the agent loop. |
| 13 | Shareable links (re-run same analysis) | **Non-fit** | Canon is not a web app; no URL to share. Workspace resume from `board.json` is the analogous primitive (`CLAUDE.md` — "resume" intent). |
| 14 | Visualization modes: folder / layer / churn / blast | **Partial overlap** | Canon's `codebase_graph` has a compliance overlay and layer inference. No dedicated "churn" or "blast" coloring mode yet — though both signals exist separately. |
| 15 | Language breadth (30+ languages, regex-based extraction) | **Partial overlap** | Canon's graph scanner is AST-based, tighter but narrower. Canon intentionally trades coverage for accuracy — `bounded-context-map.md:41` positions the KG as "structural metrics" built from real imports, not regex heuristics. |
| 16 | Keyboard shortcuts for navigation in the UI | **Non-fit** | Canon has no persistent UI surface; MCP apps are hosted by the client (Claude Desktop). |
| 17 | Duplicate code detection (mentioned in JSON export) | **Novel** | Not a Canon capability. Dead code is exposed via `graph_query` (`reference/canon-reference.md:68`), but near-duplicate block detection is not. |
| 18 | Layer violations (mentioned in JSON export) | **Duplicate** | `bounded-context-map.md:41` — layer violations are first-class KG structural metrics. Canon enforces architectural boundaries in CI (`roadmap.md:115`). |
| 19 | Function-level stats with callers / usage metrics | **Duplicate** | `graph_query` exposes call trees (`reference/canon-reference.md:68`); the KG stores entity-level edges. |
| 20 | Exclude patterns for scanning (skip caches, generated files, etc.) | **Partial overlap** | Canon's scanner has its own ignore config; it's not a user-facing pattern input per analysis. |

---

## Worth Adopting (Shortlist)

These are the ideas from CodeFlow that would plausibly strengthen Canon without conflicting with its model.

### 1. Composite "health score" for human-readable reports

CodeFlow's A–F grade collapses dead code %, cycles, coupling, and security issues into one number. Canon already has every ingredient (compliance %, cycle count, hub density, drift trends) and already renders `get_drift_report` and `get_compliance` — but there's no single summary signal. A composite score shown in the drift report would give humans a fast status read *and* give the learner a durable metric to track over time. Low build cost: it's aggregation, not new extraction.

**Fit:** Good. Slots into `get_drift_report` as an additional output field. Fits the "diagnostics" bounded context. Not orchestrator-facing.

### 2. Design-pattern and anti-pattern detection as KG annotations

Labeling "God Object" (already a high-degree hub in the KG) and "Singleton/Factory/Observer" (recognizable from import + structural patterns) would make the KG more expressive for reviewers and architects. Canon's reviewer already reasons about violations; giving it a named pattern vocabulary lets principles reference patterns (e.g., "prefer factory over direct construction") and lets the architect cite them in design briefs.

**Fit:** Good. Extends the KG via existing edge/node metadata. Most signals are already computed — what's missing is labeling. Aligns with `mcp-intelligence-roadmap.md` P3 (confidence-scored semantic edges).

### 3. Dedicated graph visualization overlays for churn and blast radius

Canon's `codebase_graph` MCP app has a compliance overlay. Adding churn and blast-radius colorings (which CodeFlow ships) would give reviewers and humans two more lenses on the same graph for ~free — the data already exists (hotspot scoring roadmap + existing blast-radius API). The investment is frontend rendering, not new analysis.

**Fit:** Good. Pure visualization layer over existing KG data. No orchestrator impact.

### 4. Duplicate-block detection (truly novel)

CodeFlow flags duplicate code in its JSON export. Canon has no near-duplicate detector. This would help the architect wave-assign tasks (duplicates should be refactored together), help the reviewer flag copy-paste drift, and give the learner a signal for "this pattern is crystallizing — promote to a utility." AST-based duplicate detection (e.g., shingling over normalized ASTs) fits Canon's KG infrastructure.

**Fit:** Good with caveats. Adds a new signal to the KG. Fits the existing KG bounded context (`bounded-context-map.md:41`). Build cost is moderate; payoff for the architect/reviewer roles is concrete.

### 5. Human-readable exportable report (Markdown) of current compliance/drift state

CodeFlow exports a Markdown analysis report. Canon's artifacts are workflow-scoped (per workspace); there is no "state of the codebase" human report independent of a flow. Adding a `canon:report` command that emits a single human-readable Markdown summary — compliance %, top hotspots, cycles, recent drift, wave-in-progress — would make Canon legible to engineering leaders who don't run flows themselves.

**Fit:** Moderate. Adds a non-flow entry point, which is a shape Canon already has (slash commands, `canon:canon-guide`). The orchestrator stays a dispatcher — the guide agent produces the report. Could be bundled with the existing `/canon:check` skill.

### 6. Static security heuristic scanner (injection, `eval`, hardcoded secrets) feeding the security-audit flow

Canon's `security-audit` flow is principle-driven (the security agent reasons about findings). CodeFlow's cheap static checks (regex for `eval()`, common secret formats, SQL string concatenation) would give the security agent a pre-filtered candidate list instead of starting from scratch. This is additive context, not a replacement for agent judgment.

**Fit:** Good. A lightweight scanner module in `mcp-server/src/features/diagnostics/` whose output is injected into the security agent's context. Orchestrator untouched.

---

## Explicit Non-Fits

Ideas from CodeFlow that should **not** be adopted because they conflict with Canon's architecture.

| Idea | Why it conflicts |
|---|---|
| **Browser-only / zero-install / CDN-hosted** | Canon runs as an MCP server with agent definitions, hooks, and local databases (`.canon/`, SQLite KG). Stateful, local, long-lived. "Just one HTML file" is architecturally incompatible. |
| **"Privacy-first, code never leaves the browser"** | Canon operates directly on the user's filesystem already. The threat model doesn't apply. |
| **Code ownership from `git blame` surfaced to agents** | Already deliberately deferred (`codebase-intelligence-roadmap.md:14`). `git blame` is noisy, expensive, and low-signal for AI agents compared to blast-radius and co-change. Adopting it would regress the roadmap decision. |
| **Shareable analysis URLs** | Canon has no server-hosted state. Workspace resume from `board.json` covers the "pick up where you left off" case in a Canon-native way. |
| **Regex-based multi-language function extraction (30+ languages)** | Canon intentionally prefers AST-based, narrower-but-accurate extraction. Regex heuristics would introduce noise into the KG, which is consumed by agents that treat it as ground truth. Trading accuracy for breadth here is a net loss. |
| **Human-facing interactive UI as the primary surface** | Canon's primary surface is the agent pipeline. MCP apps exist for visualization but are secondary. CodeFlow's "pick up your mouse and explore" model doesn't map onto "agents drive the state machine." |
| **GitHub-API-driven remote repo analysis** | Canon analyzes the local working tree (in worktrees, specifically). Remote-only analysis isn't a fit. |

---

## Summary of the Fit Assessment

CodeFlow and Canon share the **codebase-analysis primitives** (graph, blast radius, PR impact) but live on opposite sides of the "agent vs. human" divide. Most of CodeFlow's distinctive features (browser-only, shareable URLs, interactive UX, code ownership) are irrelevant or actively misaligned with Canon's orchestrator-dispatcher model.

The useful take-aways are four analytical signals CodeFlow surfaces that Canon either doesn't yet compute or doesn't aggregate: **composite health score**, **pattern/anti-pattern labels**, **duplicate-block detection**, and a **lightweight static security scanner**. All four fit as additions to Canon's existing knowledge-graph and diagnostics bounded contexts without touching the orchestrator. Two more (churn/blast visualization modes, human-readable exported report) are low-cost UI/reporting additions that improve legibility for humans without altering agent behavior.

Everything else is already done, already better, or deliberately out of scope.
