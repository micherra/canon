# Competition and Debate Orchestration

This reference codifies how the orchestrator lead orchestrates competition and debate in agent teams mode. A lead reading only this file should know exactly how to set up either pattern, inject the right framing, and drive the round-by-round or synthesis logic to completion.

These heuristics were originally codified in engine/compete.ts and engine/debate.ts (both deleted in the v2.1 migration to agent-teams orchestration). The competition and debate patterns themselves remain valid — this document is the authoritative specification for running them via native agent team dispatch.

---

## Competition Protocol

### When to Use

Competition is the right pattern when you want **divergent-then-converge exploration** — N independent takes on the same problem produced in parallel, then combined or evaluated by a synthesizer. Use it when:

- Multiple valid design directions exist and you want each explored seriously before choosing.
- A single agent self-editing is likely to converge prematurely on its first instinct.
- You want the synthesizer to have genuine alternatives to draw from, not variations of the same approach.

Do not use competition when the problem has one clearly correct answer — it adds overhead without diversity.

### Team Labeling

Assign teams labels in order: **A, B, C, D, E**. Maximum five teams. Teams are independent; they do not see each other's outputs until synthesis.

### Spawn Framing

Each competitor receives one of two framings depending on whether a lens is configured.

**With lens** — when the runbook specifies a per-team optimization target:

```
You are **Team {label}**, optimizing for: **{lens}**.

This is your primary constraint. When making tradeoffs, favor {lens} over other concerns.
Other teams are exploring different optimization targets — your job is to make the strongest
case for this direction.
```

**Without lens (generic)** — when no per-team target is specified:

```
You are **Team {label}**. Produce the best solution you can.

Other teams are independently solving the same problem — your work will be compared and
the best ideas synthesized.
```

### Synthesis Strategies

After all N competitors return, spawn a synthesizer with one of two strategies.

#### Synthesize (default)

Combine the best ideas into a unified output. The synthesizer is NOT picking a winner — it is creating something new. Use this strategy unless the runbook explicitly specifies `select`.

Synthesizer instruction:

```
You are NOT picking a winner — you are creating something new by combining the strongest
elements. However, the result must be internally coherent, not a Frankenstein of
incompatible ideas. If two inputs have genuinely incompatible approaches to the same
problem, choose one and explain the tradeoff.

For each major decision in your output:
- Note which input(s) inspired it
- Explain why you chose that approach over alternatives
```

#### Select

Pick the single best solution. Evaluate each alternative, explain the choice, note the weaknesses of the alternatives, and output the selected solution in full.

### Synthesizer Input Format

The synthesizer receives:

1. The original brief (problem statement, constraints, goals).
2. All N competitor outputs, each formatted with its team number and lens:

```
### Team 1 (lens: {lens})

{Team 1 output}

---

### Team 2 (lens: {lens})

{Team 2 output}
```

Teams are numbered 1–N in synthesis (matching the source's `out.index + 1`). The A–E labels are used only during the spawn phase (see "Team Labeling" above). If no lens was used, the label is simply `Team {N}` with no parenthetical.

### Dispatch Summary

| Step | Action |
|------|--------|
| Spawn | N agents as teammates with competing instructions (lens or generic framing) |
| Collect | Wait for all N outputs |
| Synthesize | Spawn one synthesizer with original brief + all outputs |
| Result | Synthesizer output is the competition result |

---

## Debate Protocol

### When to Use

Debate is the right pattern for **adversarial refinement** — when a position needs stress-testing before it hardens, or when a contested design question has real arguments on multiple sides. Use it when:

- A design decision has genuine tradeoffs that deserve challenge, not just consideration.
- You want weaknesses surfaced explicitly before committing to a direction.
- The question is contested enough that a single reviewer would find it hard to steelman opposing views.

### Configuration Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| `teams` | 3 | Number of debate participants |
| `composition` | configurable | Agent types per team — set in runbook |
| `min_rounds` | 2 | Do not check convergence before this round |
| `max_rounds` | 5 | Hard stop — terminate even without convergence |
| `convergence_check_after` | 3 | Do not check before this round |
| `hitl_checkpoint` | true | Present debate summary to user after completion |
| `continue_to_build` | true | Proceed to next step after HITL approval |

### Round Types and Framing

Drive debate round-by-round. Inject the appropriate framing instruction at the start of each round's spawn prompt.

**Round 1 — Position:**

```
Present your approach to the problem. Be specific and concrete. Explain your core idea,
the key tradeoffs you're making, and why you believe this direction is strongest.
```

**Round 2 — Challenge:**

```
Find weaknesses, gaps, and risks in their approaches. Ask pointed questions. Identify
assumptions they haven't justified. Point out edge cases they haven't considered.
Be rigorous but fair.
```

**Round 3 — Response:**

```
Address each challenge directly: if valid, revise and explain; if misguided, defend with
specific reasoning; if genuine tradeoff, acknowledge and explain why your direction is
still preferable.
```

**Round 4+ — Narrow:**

```
Focus ONLY on unresolved disagreements. Do not re-litigate settled points. If you believe
the debate has converged and there's nothing meaningful left to discuss, say so explicitly.
```

### Channel and Sender Naming

- **Channel**: `debate-round-{N}` (e.g., `debate-round-1`, `debate-round-3`)
- **Sender**: `round-{N}-{team-slug}-{agent-slug}` — slugified lowercase, non-alphanumeric characters replaced with hyphens

Example: round 2, team "Team Alpha", agent "architect" → `round-2-team-alpha-architect`

### Convergence Detection

Check convergence only after completing round N where N ≥ max(min_rounds, convergence_check_after). Do not check earlier.

**Convergence terms** (8 total): `agree`, `converged`, `consensus`, `same conclusion`, `nothing left to discuss`, `no remaining disagreement`, `aligned`, `on the same page`

**Negation filtering**: Before counting a term as a convergence signal, check the 50-character window preceding the term for any of these negation words (matched at word boundaries):

```
don't  dont  doesn't  doesnt  not  no  never  can't  cant  won't  wont
```

"don't agree" does NOT count as convergence. "we agree" does.

**Scoring rules**:

- Count at most one convergence signal per message (first matching term wins).
- A message containing a negated convergence term counts as zero signals.

**Thresholds — converged when either condition is met**:

| Condition | Threshold |
|-----------|-----------|
| Majority convergence | ≥ 66% of messages in the round contain a non-negated convergence term |
| Brevity heuristic | Average message length < 100 characters (debate exhausted) |

**Algorithm**:

```
after each round where round_number >= max(min_rounds, convergence_check_after):
  signals = 0
  total = 0
  total_length = 0
  for each message in round:
    total += 1
    total_length += len(message)
    for term in convergence_terms:
      lookback = message[max(0, position(term)-50):position(term)]
      if no negation word (word-boundary match) in lookback:
        signals += 1
        break  # one signal per message maximum
  if signals / total >= 0.66 or total_length / total < 100:
    convergence = true
```

If convergence is detected before `max_rounds`, stop the debate. If `max_rounds` is reached without convergence, stop anyway.

### HITL Checkpoint

When `hitl_checkpoint: true` (the default), after the debate completes present a summary to the user:

- Each team's final position (round 3+ response, or last message).
- Unresolved disagreements (points that were challenged but not withdrawn).
- Convergence status: whether the debate converged naturally or hit the round cap.
- Recommended synthesis or selection direction, if one is clear.

Wait for user approval before proceeding. When `continue_to_build: true`, proceed to the next runbook step after approval.

### Dispatch Summary

| Step | Action |
|------|--------|
| Spawn teams | Agent(s) per team per round — composition from runbook |
| Channel | `debate-round-{N}` |
| Framing | Inject round-type framing into each team's spawn prompt |
| Convergence | Check after each qualifying round; stop early if converged |
| Max cap | Terminate at `max_rounds` regardless |
| HITL | Present summary when `hitl_checkpoint: true` |
| Continue | Proceed to next step when `continue_to_build: true` and user approves |

---

## Dispatch Guidance

The CLAUDE.md dispatch framework entry for this pattern is:

> **Debate / competing hypotheses → Agent team**

**Competition**: spawn N agents as teammates with competing instructions (lens or generic framing), collect outputs, spawn synthesizer.

**Debate**: spawn teams with composition agents per round, drive round-by-round with framing injection, check convergence after each qualifying round. Present HITL checkpoint on completion.

Both patterns are native Claude orchestration — no custom state machine logic required. The framing instructions above and the convergence algorithm are the complete specification.
