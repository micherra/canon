# Canon Domain Primers

This directory contains domain primers — short documents that give Canon's specialist agents the right mental models for reasoning in a specific technical domain. Primers are not procedural instructions; they are cognitive context that helps agents apply Canon's principles with good judgment rather than mechanically.

## Why Primers Exist

Canon's principles are universal — they apply across every codebase and every task. But the right way to apply a principle often depends heavily on the domain. "Validate at trust boundaries" means something different in a REST API layer than in an infrastructure provisioning script. A primer gives the agent the domain-specific knowledge it needs to make that judgment call correctly.

Without primers, agents in unfamiliar domains tend to apply principles too rigidly or miss the domain-specific failure modes that experienced engineers know to watch for. Primers compress that expertise into a form that fits in an agent's context.

## What's in a Primer

Each primer covers three things:

**Mental models** are the key conceptual lenses for the domain — the frameworks that make multiple principles feel intuitive rather than arbitrary. For example, the backend-API primer explains Hyrum's Law as a mental model: every observable behavior you ship effectively becomes a permanent contract, which is why additive changes are safe and modifications are not. This single model explains why several different principles apply the way they do in API work.

**Decision frameworks** address the recurring judgment calls that principles can't prescribe. When should you version an API versus extend it? When is offset-based pagination better than cursor-based? These are domain-specific decisions with domain-specific heuristics.

**Failure modes** catalogue the things that go wrong in this domain — not generic bugs, but domain-physics failures that only make sense once you understand how the domain works. Knowing the common failure modes helps agents spot risky patterns before they become problems.

## Current Primers

Primers cover the major technical domains that Canon projects encounter: REST and RPC API design, database access patterns and data modeling, safe deprecation strategies, frontend component and state management patterns, infrastructure and deployment concerns, and test strategy. Each is 40–80 lines — long enough to be substantive, short enough to fit in context without crowding out other information.

## How Primers Are Used

The architect or orchestrator sets a `domains:` field in a task plan's frontmatter. When the orchestrator spawns an agent for that task, it reads the corresponding primer files and injects them into the agent's context alongside the task plan and principles. Agents do not load primers directly — this happens transparently during spawn.

## Writing a New Primer

Use the template at `templates/domain-primer.md` as your guide. Before adding content, check whether an existing Canon principle already captures the idea — primers should complement principles, not repeat them.

A good primer covers the terrain that is genuinely domain-specific: the mental models, trade-off navigation, and failure physics that are too contextual to encode as universal principles. Keep the file in the 40–80 line range and name it after the domain it covers.
