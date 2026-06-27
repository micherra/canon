---
id: model-step-in-agent-layer
title: Model-Backed Pipeline Steps Live in an Agent Skill, Not a Tool
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "mcp-server/**"
    - "agents/**"
    - "skills/**"
tags:
  - agent-behavior
  - mcp-server
  - architecture
  - testability
---

When a pipeline spans the deterministic (MCP tool) and model-backed (agent) boundary, the model-backed generation step belongs in a markdown skill added to the calling agent's `skills:` frontmatter — not in a new MCP tool, and not in a new agent. Deterministic steps (selection, ranking, budgeting, gating, shaping) remain MCP tools: pure functions with injected I/O, zero LLM calls, independently unit-testable.

This is the positive prescription that complements the `no-llm-calls-in-mcp-tools` rule. That rule specifies where the LLM call must NOT go; this convention specifies where it DOES go.

## Rationale

The determinism boundary is the invariant Canon's fitness gates rely on. `evaluate_candidate`, `select_mutation_targets`, and similar gating tools are trustworthy precisely because no LLM call can contaminate their output — they return a deterministic verdict the orchestrator can act on without second-guessing. Moving any generation call into those tools poisons the gate.

The skill placement is the lightest-weight model-backed mechanism available. The calling agent already has the domain context. A markdown skill directs its existing model capability toward generation without adding a new spawn, a new identity, or a new context boundary. A new agent adds coordination overhead the generation step does not need; a new MCP tool violates `no-llm-calls-in-mcp-tools`.

**Cross-run evidence (trace-evolution series, 4 builds):**

| Build | Deterministic (MCP tool) | Model-backed (agent skill) |
|-------|--------------------------|---------------------------|
| #413 — provenance | `capture_context_provenance` — pure FS + hash | learner reads and extracts provenance signals |
| #414 — fitness gate | `evaluate_candidate` — subprocess gate, no LLM | generation deferred (not built yet) |
| #418 — attribute_failure | `attribute_failure` — pure attribution join | learner analysis step |
| #421 — mutator | `select_mutation_targets` + `evaluate_candidate` | `evolve-candidate/SKILL.md` inline sonnet rewrite |

DESIGN.md locked decision #1 names this split a "non-negotiable constraint." AC#2 verified by grep: zero model/anthropic/messages.create imports in `mcp-server/src/features/evolution/services/` and `tools/`. Meets the weighted_instance_count >= 3 threshold for promotion.

## Examples

**Correct — deterministic MCP tool + agent skill for generation:**

```typescript
// mcp-server/src/features/evolution/tools/select-mutation-targets.ts
// Pure selection: no Anthropic import, no network call
export function selectMutationTargets(
  candidates: EvolutionCandidate[],
  budget: number,
): SelectedTargets {
  return candidates
    .filter(isGateEligible)
    .sort(byPriorityScore)
    .slice(0, budget)
    .map(shapeMutationProposal);
}
```

```markdown
<!-- skills/canon/skills/evolve-candidate/SKILL.md — agent layer -->
Step 3: Call select_mutation_targets to get the ranked proposal list.
Step 4: For each proposal, produce a rewritten variant using the model...
```

The tool is a pure function. Generation lives in the markdown skill, at agent altitude, where model output is expected.

**Violation — model call inside an MCP tool:**

```typescript
// BAD: generation inside a tool handler
import Anthropic from "@anthropic-ai/sdk";  // violates no-llm-calls-in-mcp-tools

export async function selectAndGenerate(candidate: EvolutionCandidate) {
  const targets = selectMutationTargets([candidate], 1);
  const client = new Anthropic();
  const response = await client.messages.create({ ... });  // poisons the deterministic gate
  return response;
}
```

The tool now makes a non-deterministic judgment, cannot be unit-tested without mocking the API, and directly violates `no-llm-calls-in-mcp-tools`.

**Violation — new agent spawned just to wrap the model step:**

```yaml
# BAD: separate agent whose sole purpose is to call the model for one generation step
# agents/mutator.md
description: >
  Spawns to rewrite a single mutation candidate. Receives select_mutation_targets
  output and calls the model to produce a rewritten variant.
```

A full agent adds spawn cost, a context boundary, and an identity the generation step does not need. Use a skill on the calling agent instead.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The generation logic is complex — it deserves its own agent." | Complexity of the generation prompt is not a reason to spawn a new agent. The calling agent already has context and tooling. A more detailed skill body handles prompt complexity. | Add the generation steps to the calling agent's skill; keep the MCP tool deterministic. |
| "Putting LLM calls in the tool gives us one place to tune generation." | The tool layer is the deterministic contract layer. Centralizing tuning there trades testability for convenience and violates the design boundary. | Tune generation in the skill markdown — it is already the single source for the generation step. |
| "We already have a new agent set up — it's simpler to put generation there." | A dedicated agent imposes a spawn cost and a context transfer at every pipeline run. The calling agent paying a skill invocation has neither cost. | Fold the skill into the calling agent's `skills:` frontmatter. Remove the dedicated agent if it has no other responsibilities. |

## Verification

- [ ] For each pipeline with both a gating/selection step and a generation step: confirm the gating step is a pure MCP tool — run `grep -r "anthropic-ai/sdk\|messages\.create\|generateText\|streamText" mcp-server/src/features/` and confirm zero hits in the relevant tool file.
- [ ] Confirm the generation step is a markdown skill in the calling agent's `skills:` frontmatter: `awk '/^skills:/{in_s=1; next} in_s && /^[^ \t]/{exit} in_s{print}' agents/<agent>.md` lists the skill.
- [ ] No new agent was spawned solely to wrap the model-backed generation step — the skill is on the calling agent that already has domain context.
