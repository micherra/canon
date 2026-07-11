# ADR-0048: Tool-surfacing gate classifies agent-facing vs orchestrator-only via a central allowlist

- **Status:** Accepted
- **Date:** 2026-07-10
- **Context tags:** hooks, dead-wire, mcp-tool-contract, agent-surfacing

## Context

Canon's `hooks/dead-wire-gate.sh` catches a symbol with zero **code** references. It cannot
catch a distinct dead-wire class: a tool that is code-reachable yet **behaviorally
unreachable** — registered on the MCP server but surfaced in no agent grant and no
instruction surface. Inc-0 of the event-backbone epic (PR #450) shipped three such tools
(`post_message`, `tail_messages`, `list_active_workspaces`); an empirical probe (2026-07-10)
confirmed 0 uses across all 19 workspace `orchestration.db` files, because no agent knew the
tools existed. The capability's entire purpose — measuring cross-session demand — was dead on
arrival.

We are adding a fail-closed gate, `hooks/tool-surfacing-check.sh`, to prevent this class. The
load-bearing question is not *how to detect* an unsurfaced tool (set subtraction of registered
minus granted is trivial) but *how to classify* which registered tools are legitimately
unsurfaced. Of 67 registered tools, 33 are orchestrator-only (`init_workspace`, `log_step`,
`compute_autonomy_tier`, …) or internal — a subagent is never meant to call them. A naive
"every registered tool must appear in an agent grant" rule false-positives on all 33 and would
be immediately disabled.

## Decision

The gate uses a **binary partition with a central allowlist as the explicit negative
classifier**. A registered tool is legitimate if ANY of:

1. it appears in some `agents/*.md` frontmatter `tools:` block as `mcp__canon__<name>`
   (positive signal — agent-facing and granted); or
2. it is listed in `hooks/lib/orchestrator-only-tools.txt` (explicit classification —
   orchestrator-only / internal, legitimately not agent-granted); or
3. its `registerTool(` / `registerToolWithUi(` call carries an inline
   `// canon:allow-unsurfaced: <reason>` marker (one-off not-yet-wired exception).

Any registered tool with none of the three fails the gate closed (exit 2). The allowlist is
the single authoritative source of truth for the "orchestrator-only / internal" classification,
mirroring the established `hooks/lib/accepted-skip-reasons.txt` single-source idiom. Each entry
sits under a reasoned category comment.

The gate's **positive** signal is agent-grant presence, NOT prose mention in CLAUDE.md /
references. Prose mentions are noisy (a deprecation note, an example, a phantom `get_messages`
row) and would false-negative-suppress genuine dead wires. The "instruction surface" half of
the dead-affordance condition is subsumed by the allowlist: an orchestrator-only tool is
surfaced to the orchestrator via CLAUDE.md, and its allowlist entry is the deterministic proxy
for that.

## Alternatives considered

- **Inline source marker only (no central file).** Rejected as the *primary* mechanism: a
  central list is auditable with `cat` rather than a tree-wide grep, and the classification
  reason lives beside the name. Retained as a *secondary* one-off escape hatch (option 3).
- **Tool metadata / MCP annotations.** Rejected: requires a registration/schema change —
  out of scope ("prompting, not plumbing") and couples the gate to the SDK.
- **Derive classification from the registration file** (e.g. `register-orchestration.ts` ⇒
  orchestrator-only). Rejected as structurally false: `post_message` / `tail_messages` live in
  `register-messaging.ts` yet ARE agent-facing. File location does not encode intent.
- **A learner watch instead of a hard gate.** Rejected by the user: advisory and
  retrospective; would not have prevented #450 from shipping the dead wire.

## Consequences

**Positive.** No MCP tool can ship as a behavioral dead wire — a new tool must be either
granted (agent-facing) or classified (allowlist/marker), or the verify step blocks. The
classification is explicit and auditable, never a heuristic guess, so the gate has a zero
false-positive posture for classified tools.

**Negative / cost.** `hooks/lib/orchestrator-only-tools.txt` becomes a load-bearing contract:
every future orchestrator-only tool must add a line, and removing the file means re-deciding
the classification for 33+ tools. The residual risk is *misuse* — dumping a genuinely
agent-facing tool into the allowlist to silence the gate — mitigated by (a) reasoned category
comments, (b) `hooks/lib/**` being a sensitive path (allowlist diffs are supervised +
adversarially re-reviewed), and (c) explicitly reversible reasons for borderline entries
(`search_knowledge`, `recall`: "grant to an agent + delete this line if an agent needs it").

**Scope.** The gate is one-directional (registered → surfaced). The reverse class
(granted-but-unregistered) is empirically absent today and out of scope. The gate is EXEMPT
from the doc-only verify-skip (removing an agent grant is a `.md`-only drift class) and takes
only `[worktree_path]` (surfacing is a whole-tree property, not diff-scoped), matching the four
sibling corpus gates (ADR-0042).
