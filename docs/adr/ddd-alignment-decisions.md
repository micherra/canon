# ADR: DDD Alignment Decisions

**Directory**: `docs/adr/`
**Related**: `docs/bounded-context-map.md`

This document records the architectural decisions made during the DDD alignment refactoring of the Canon MCP server. Each decision follows the standard ADR format.

---

## ADR-DDD-01: Capability Interfaces as Cross-Context Anti-Corruption Layers

**Status**: Accepted

### Context

The Orchestration Context has two concrete coupling violations:

| File | Violating import | Direction |
|------|-----------------|-----------|
| `engine/effects.ts` | `import { DriftStore } from "@platform/storage/drift/store.ts"` | Orchestration → Drift |
| `services/inject-context.ts` | `import { KgStore } from "@graph/kg-store.ts"` | Orchestration → Knowledge Graph |

These cross-context concrete imports couple Orchestration to the implementation details of KG and Drift storage. Any refactoring of `KgStore` or `DriftStore` internals risks breaking the Orchestration engine. The bounded-context-map documents these as known violations pending a fix.

The Canon principle `bounded-context-boundaries` (strong-opinion) flags such imports. The narrower `capability-interface-required` principle (see ADR-DDD-04) raises this to a hard block for cross-context concrete imports.

### Decision

Introduce capability interfaces in the `domains/` layer to serve as anti-corruption layers (ACLs) between contexts:

- `IKgStore` in `mcp-server/src/domains/knowledge-graph/` — capability interface for Knowledge Graph storage operations needed by Orchestration
- `IKgQuery` in `mcp-server/src/domains/knowledge-graph/` — capability interface for KG analytical queries
- `IDriftStore` in `mcp-server/src/domains/drift/` — capability interface for Drift/Review persistence operations needed by Orchestration

Concrete implementations (`KgStore`, `KgQuery`, `DriftStore`) satisfy these interfaces structurally. Orchestration imports only the interface types from `domains/`; the concrete classes remain invisible to the Orchestration context. The Platform layer wires concrete implementations to the interfaces at startup.

### Consequences

**Positive**:
- Orchestration Context is decoupled from KG and Drift storage implementations
- Refactoring either storage layer does not require Orchestration changes
- `dependency-cruiser` can enforce the interface boundary via `forbidden` rules (see ADR-DDD-05)
- Pattern is extensible: future contexts follow the same interface-in-domains convention

**Negative**:
- Interface duplication: capability interfaces must stay synchronized with their concrete counterparts
- Platform wiring layer must be updated whenever new capability methods are added

**Related principles**: `bounded-context-boundaries`, `capability-interface-required`, `architectural-fitness-functions`

---

## ADR-DDD-02: DEFERRED-DI Exception Pattern for Incremental Boundary Enforcement

**Status**: Accepted

### Context

Full dependency-injection wiring across all boundary violations cannot always be completed in a single task or commit. During refactoring waves, some concrete imports may persist temporarily while others are resolved. Without a structured exception pattern, these temporary violations are indistinguishable from permanent design choices or overlooked violations.

The `.dependency-cruiser.cjs` config enforces boundary rules as `forbidden` import patterns with `severity: "error"`. When a concrete violation must temporarily remain (e.g., because the interface and DI wiring are deferred to a later task), the dep-cruiser check fails CI unless an exception is recorded.

### Decision

When full DI wiring cannot be completed in the current task, concrete cross-context imports are allowed temporarily via `pathNot` exceptions in `.dependency-cruiser.cjs`. Each exception **must** include a structured comment with two required fields:

```js
// DEFERRED-DI: <reason why full wiring is deferred>
// REMOVES-WHEN: <trigger that makes this exception removable>
{ path: "...", pathNot: "..." }
```

Example:
```js
// DEFERRED-DI: IKgStore interface not yet created; wiring deferred to task ddd-03
// REMOVES-WHEN: IKgStore lands in domains/knowledge-graph/ and inject-context.ts is updated
{ path: "src/features/orchestration/services/inject-context.ts", pathNot: "src/graph/kg-store.ts" }
```

All active DEFERRED-DI exceptions are tracked in the bounded-context map under the relevant context's "Current boundary violations" section. When the trigger condition is met, both the exception and the bounded-context map entry are removed.

### Consequences

**Positive**:
- Incremental refactoring is possible without failing CI at every intermediate state
- Exceptions are self-documenting: cause and removal condition are co-located with the rule
- The bounded-context map provides a single view of all outstanding deferrals
- Future reviewers can audit all deferrals without scanning the entire dep-cruiser config

**Negative**:
- Risk of deferrals becoming permanent if removal triggers are not acted on
- Adds maintenance discipline requirement: bounded-context map must be kept current

**Mitigation**: The `capability-interface-required` principle (rule severity, see ADR-DDD-04) requires reviewers to treat any new `pathNot` exception addition as a rule-level finding that must be explicitly documented with DEFERRED-DI/REMOVES-WHEN comments.

**Related principles**: `capability-interface-required`, `architectural-fitness-functions`, `fail-closed-by-default`

---

## ADR-DDD-03: Branded Value Object Types for Domain Identifiers

**Status**: Accepted

### Context

The Canon MCP server passes domain identifiers as raw strings across context boundaries:

- `workspacePath: string` — filesystem path identifying a workspace
- `flowName: string` — name identifying a flow definition
- `stateId: string` — name identifying a state within a flow

TypeScript's structural type system treats all `string` values as interchangeable. This allows identifier confusion bugs — e.g., passing a `flowName` where a `stateId` is expected — that the compiler does not catch. The `aggregates-reference-by-id` Canon principle (strong-opinion) advocates for domain-typed identifiers.

### Decision

Introduce TypeScript branded types for the three primary domain identifiers using Zod's `.brand()` API:

```typescript
// mcp-server/src/domains/flows/value-objects.ts
import { z } from "zod";

export const WorkspacePathSchema = z.string().brand<"WorkspacePath">();
export type WorkspacePath = z.infer<typeof WorkspacePathSchema>;

export const FlowNameSchema = z.string().brand<"FlowName">();
export type FlowName = z.infer<typeof FlowNameSchema>;

export const StateIdSchema = z.string().brand<"StateId">();
export type StateId = z.infer<typeof StateIdSchema>;
```

Usage pattern: raw strings entering the system at MCP tool handler boundaries are coerced via `WorkspacePathSchema.parse(rawString)`. Internal domain functions accept branded types. This prevents cross-boundary misuse without runtime overhead beyond the initial parse.

Adoption is forward-looking: existing raw-string usages are not retroactively required to migrate. New domain-crossing identifier parameters use branded types.

### Consequences

**Positive**:
- Compiler catches identifier-interchange bugs at call sites
- Zod integration provides parse-time validation with no additional dependencies
- Extends the existing Zod schema pattern already used throughout the codebase

**Negative**:
- Requires explicit coercion at system entry points (MCP tool handlers)
- Cannot be machine-checked by dep-cruiser (not an import pattern); requires review-time enforcement
- TypeScript's structural typing means branded types can be bypassed with a cast — relies on code review discipline

**Severity**: `strong-opinion` — violations are flagged in review but not hard-blocked, reflecting TypeScript's enforcement limitation (see ADR-DDD-05).

**Related principles**: `domain-identifier-types`, `aggregates-reference-by-id`, `ubiquitous-language-in-code`

---

## ADR-DDD-04: `capability-interface-required` Principle Severity as `rule`

**Status**: Accepted (decision-id: ddd-01)

### Context

The `capability-interface-required` principle governs cross-context access via capability interfaces. It needs a severity level consistent with the actual enforcement tooling. The parent `bounded-context-boundaries` principle is `strong-opinion`. The question is whether to match parent severity or raise it.

The dep-cruiser config enforces cross-context concrete import violations as `severity: "error"` — a CI-blocking finding. If the principle were `strong-opinion`, the principle would be softer than the tool, creating an inconsistency: a violation could be justified at the principle level while still failing CI.

### Decision

Set `capability-interface-required` severity to `rule` (hard block). This aligns declared severity with the actual dep-cruiser enforcement level. The principle is narrower than `bounded-context-boundaries` (it covers only cross-context concrete imports) and is machine-checkable, justifying a stricter severity than its parent.

Any `pathNot` exception added to dep-cruiser for a cross-context concrete import must follow the DEFERRED-DI pattern (ADR-DDD-02) and is treated as a `rule`-level finding requiring explicit documentation and removal planning.

### Consequences

- New cross-context concrete imports fail both `npm run lint:deps` (CI) and principle compliance checks
- Reviewers must flag any `pathNot` exception additions as `rule` violations
- A `strong-opinion` that conflicts with a `rule`-severity tool check is resolved in favor of the rule

**Revisit if**: The project adopts a DI container that makes interface routing automatic, or a legitimate safe cross-context concrete import pattern emerges.

**Related principles**: `capability-interface-required`, `architectural-fitness-functions`, `fail-closed-by-default`

---

## ADR-DDD-05: `domain-identifier-types` Principle Severity as `strong-opinion`

**Status**: Accepted (decision-id: ddd-02)

### Context

The `domain-identifier-types` principle advocates branded/opaque types for domain identifiers. TypeScript has no native nominal typing; branded types are a convention enforced by code review, not by the compiler or static analysis tools. No dep-cruiser rule can detect a raw-string `workspacePath` parameter vs. a branded `WorkspacePath` parameter.

### Decision

Set `domain-identifier-types` severity to `strong-opinion`. Reviewers flag new domain identifier parameters that cross context boundaries without branded types. Existing raw-string usages are not retroactively flagged. Adoption is forward-looking.

This severity is lower than `capability-interface-required` (rule) because branded type violations cannot be machine-checked. Setting it to `rule` without automated enforcement would make the principle unactionable as a hard block.

### Consequences

- New cross-boundary identifier parameters use branded types; violations are review-flagged but not CI-blocked
- If a custom ESLint rule or tsc plugin is added to machine-check branded type usage, severity upgrades to `rule`
- If branded types prove too noisy or brittle in practice, severity downgrades to `convention`

**Related principles**: `domain-identifier-types`, `aggregates-reference-by-id`

---

## ADR-DDD-06: `dependency-cruiser` as Architectural Fitness Function Enforcement

**Status**: Accepted

### Context

The Canon MCP server's bounded-context boundaries need automated enforcement. Without tooling, boundary violations accumulate silently between reviews. The Canon principle `architectural-fitness-functions` advocates automated checks that guard architectural properties continuously.

`.dependency-cruiser.cjs` is already present in the repo with basic rules. The question is how to extend it to encode the bounded-context map's boundary rules.

### Decision

`.dependency-cruiser.cjs` encodes bounded-context boundary rules as `forbidden` import patterns with `severity: "error"`. Each rule corresponds to a cross-context import direction that the bounded-context map designates as forbidden. Rules follow this structure:

```js
{
  name: "no-orchestration-to-kg-concrete",
  severity: "error",
  comment: "Orchestration must use IKgStore/IKgQuery interfaces, not concrete KgStore/KgQuery classes",
  from: { path: "src/features/orchestration/" },
  to: { path: "src/graph/", pathNot: "..." }
}
```

`pathNot` exceptions follow the DEFERRED-DI pattern (ADR-DDD-02). All rules run in `npm run lint:deps` (CI gate). New bounded-context relationships must add a corresponding dep-cruiser rule before the interface lands.

This approach aligns dep-cruiser rule definitions with the bounded-context map: the map describes the intent, dep-cruiser enforces it continuously.

### Consequences

**Positive**:
- Boundary violations are caught at CI time, not at review time
- Rules are self-documenting via `name` and `comment` fields
- Adding a new context requires adding a new rule — the process is explicit

**Negative**:
- Dep-cruiser rules require maintenance as directory structures evolve
- Path-based rules are brittle to directory renames (update rules when directories move)

**Revisit if**: The project adopts a module federation or monorepo tool that provides native boundary enforcement.

**Related principles**: `architectural-fitness-functions`, `capability-interface-required`, `fail-closed-by-default`

---

*This ADR file is the authoritative record of DDD alignment decisions. The bounded-context map (`docs/bounded-context-map.md`) references these decisions but does not duplicate their rationale.*
