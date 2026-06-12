---
adr: "0006"
title: "Relocate cross-feature shared surfaces to their correct architectural homes"
status: accepted
date: "2026-06-12"
build: "enforce-ai-navigability-canon-already-preaches-name-the-grey-box-model"
---

# ADR-0006: Relocate cross-feature shared surfaces to their correct architectural homes

## Context

The `no-cross-feature-internal-import` rule (ADR-0005 context) surfaced four clusters of feature→feature edges that are NOT foundational-service dependencies (those are handled by ADR-0005) but rather *misfiled logic* — code that physically lives in one feature while conceptually belonging to a shared layer or to its sole consumer:

- **ORCH-PRESENT** (1 edge): `pr-review/present-review.ts` → `orchestration/tools/present-artifact.ts`. `presentArtifact` is a generic "serve HTML over the Canon HTTP server + open browser" utility depending only on `@app/http-server`, `@platform/adapters`, `@shared`. It is not orchestration-specific.
- **HISTORY-ARCHIVAL** (3 edges): `orchestration/{janitor,workspace-cleanup,digest-writer}` → `history/services/{archive-service,run-summary-extractors}`. `archiveWorkspace` is a workspace-lifecycle persistence service (writes workspace state to the archive/drift DB); `run-summary-extractors` are pure extraction helpers. Orchestration owns the lifecycle (cleanup/janitor/digest) and reaches *down* into history for archival — an inverted dependency.
- **DIAGNOSTICS-ENRICH** (3 edges): `orchestration/resolve-agent-skills.ts` → `diagnostics/services/{area-memory-enrichment,hot-file-detection,pitfall-enrichment}`. These three "spawn-prompt enrichment" services are consumed *only* by orchestration's `resolve_agent_skills` (verified: no diagnostics tool imports them). They build sections of an agent spawn prompt — an orchestration concern misfiled under diagnostics.
- **CRAFT-PERSIST** (1 edge): `orchestration/report.ts` → `pr-review/store-pr-review.ts` (`validateAndPersistCraftProfile`). This function validates a `CraftProfile` and persists it to the drift DB; it depends only on `@platform/storage/drift` and `@shared`. It is a drift-persistence concern misfiled under pr-review.

Per the user's direction (2026-06-12), these are decoupled by **real code relocation**, not grandfathered. The question is *where* each surface should live.

## Options Considered

### Option A: Relocate each surface to its correct home (chosen)

- ORCH-PRESENT → move the reusable `presentArtifact` function + types to `src/app/artifact-presentation.ts` (app is the composition root; it may depend on `@app/http-server`). Orchestration's `present_artifact` MCP tool and pr-review's `present_review` both import from `@app/`.
- HISTORY-ARCHIVAL → move `archive-service.ts`, `run-summary-extractors.ts`, and their internal helper `run-summary-builder.ts` to `src/platform/storage/archive/` (archival is platform-level persistence). History tools and orchestration services both import from `@platform/storage/archive/`.
- DIAGNOSTICS-ENRICH → move the three enrichment services into `src/features/orchestration/services/` (their sole consumer). Cross-feature edge becomes a same-feature import.
- CRAFT-PERSIST → move `validateAndPersistCraftProfile` to `src/platform/storage/drift/craft-persistence.ts` (drift persistence). Orchestration's `report.ts` and pr-review's `store-pr-review.ts` both import from `@platform/storage/drift/`.

**Pros:**
- Each edge is genuinely eliminated; the depcruise gate is green with no grandfathers in these clusters.
- Each surface lands where its dependencies and consumers say it belongs (app/platform/orchestration), improving discoverability.
- Behavior-preserving moves (re-export shims at the registration layer keep MCP tools wired).

**Cons:**
- Touches several orchestration files (janitor at 551 lines — near the 600-line limit), raising merge-conflict risk across parallel tasks. Mitigated by wave sequencing (see DESIGN.md execution strategy).
- Introduces a small number of `@app` and `@platform/storage/archive` import sites that did not exist before.

**Canon-principle alignment:** honors `bounded-context-boundaries` (logic lives in its true context), `information-hiding` (consumers import a stable home, not a sibling's internals), `simplicity-first` (moves, not new abstractions), `architectural-fitness-functions` (the rule stays green by structure, not suppression).

### Option B: Lift each surface into `@domains/*` as interface + keep impl in the feature (dependency inversion via interfaces)

Define interfaces in `@domains/*`, have consumers depend on the interface, and wire concrete implementations at the composition root.

**Pros:**
- Maximal decoupling; testable seams.

**Cons:**
- Over-engineered for single-implementation services (one archiver, one craft-persister, one presenter). Introduces interface indirection with no second implementor — tensions `no-dead-abstractions` / `patterns-need-justification`.
- The existing DEFERRED-DI grandfathers in the config show Canon has deliberately *deferred* DI wiring; adding ad-hoc interfaces here contradicts that posture.

**Canon-principle alignment:** tensions `no-dead-abstractions`, `simplicity-first`, `patterns-need-justification`.

## Decision

Chosen: **Option A — Relocate each surface to its correct architectural home.**

Each of the four clusters is a *placement* error, not a coupling that needs an abstraction. The fix is to move the logic to the layer its dependencies and consumers indicate: app (presentation), platform/storage (archival, craft persistence), or the sole-consuming feature (enrichment → orchestration). Dependency inversion (Option B) is rejected as over-engineering for single-implementation services and as contrary to Canon's deferred-DI posture.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| bounded-context-boundaries | honors | Each surface lands in its true context (app/platform/orchestration). |
| information-hiding | honors | Consumers import a stable layer home, not a sibling feature's internals. |
| simplicity-first | honors | Relocation, not new interfaces or layers. |
| no-dead-abstractions | honors | Rejected Option B's single-impl interfaces. |
| architectural-fitness-functions | honors | depcruise stays green by structure, not suppression. |
| command-query-separation | honors (mild) | Moves preserve existing function contracts; no behavior change. |

## Consequences

**Positive:**
- 10 of the 16 cross-feature edges (all but the 7 KG-PUBLIC edges, of which 1 overlaps confidence-scorer→graph-query — see DESIGN.md table) are eliminated by relocation; combined with ADR-0005, the depcruise gate is green with exactly one documented allowance (KG).
- `src/platform/storage/archive/` and `src/platform/storage/drift/craft-persistence.ts` become the discoverable homes for archival and craft persistence.
- MCP tool wiring is preserved via re-export at the `register-*.ts` layer (no tool behavior change — satisfies the "no change to runtime tool behavior" scope constraint).

**Negative / trade-offs:**
- Several orchestration files are touched; `janitor.ts` (551 lines) needs care to stay under the 600-line Biome limit — the move REMOVES an import and a call site, so net lines decrease, but the engineer must confirm.
- New import sites in `@app` and `@platform/storage/archive` slightly broaden those layers' fan-in.

## Revisit-If

- A second implementation of any relocated service appears (e.g., a non-DB archiver) — then introduce a `@domains/*` interface (Option B) for that specific service.
- `presentArtifact` grows beyond HTTP-serving into richer presentation logic — reconsider a dedicated `src/ui/`-adjacent presentation module instead of `@app/`.
