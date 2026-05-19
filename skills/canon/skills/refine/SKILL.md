---
name: refine
description: >-
  Requirements sharpening for build requests. Classifies request fuzziness
  into tiers (trivial, clear, fuzzy) and applies proportionate PM effort --
  from pass-through to full creative divergence. Produces a sharpened-request
  artifact for architect hand-off. Used by the PM orchestrator.
user-invocable: false
---

# canon:refine — Requirements Sharpening Skill

This skill defines the PM's protocol for sharpening build requests before routing to the architect. It scales effort to fuzziness: trivial requests pass through, clear requests get stress-tested, fuzzy requests get full creative divergence before converging.

## 1. Tier Classification

Determine which tier applies to the incoming request. This is the first
thing the PM does after intent classification confirms a build request.

### Trivial
- Gate: Clear bug fix, fully-specified change, explicit acceptance criteria
  already stated by the user. No ambiguity about scope or behavior.
- Action: Skip refine entirely. Proceed directly to scope check
  (get_file_context / graph_query for routing to engineer or architect).
- Artifact: None. The user's request IS the specification.

### Clear
- Gate: Well-defined feature request with identifiable scope. The user
  knows what they want, but may have implicit assumptions, missing
  acceptance criteria, or unstated scope boundaries.
- Action: Run the stress-test protocol (Section 2). Confirm acceptance
  criteria and scope boundaries with the user.
- Artifact: sharpened-request.md (written to
  ${WORKSPACE}/plans/${slug}/sharpened-request.md)

### Fuzzy
- Gate: Exploratory, vague outcome, multiple valid interpretations.
  Examples: "improve performance", "clean up the API layer", "make the
  search better", "I'm thinking about reworking auth".
- Action: Run the full diverge-then-converge protocol (Section 3).
  Generate alternative framings, converge with user, then stress-test.
- Artifact: sharpened-request.md

## 2. Stress-Test Protocol (Clear Tier)

Used for clear-tier requests and as the second phase of fuzzy-tier
requests (after divergence converges).

### Phase 1: Investigate
Run 1-2 MCP triage calls (get_file_context, graph_query) to ground the
conversation in codebase reality. This is the same scope check the PM
already does -- but the results now inform the stress-test questions.

### Phase 2: Apply Frameworks
Apply these frameworks to the request. You do not need to use all of
them -- pick the 1-2 that are most revealing for this specific request.

**Pre-mortem**: "If this build fails 2 weeks from now, what went wrong?"
Surface risks the user hasn't considered. Focus on scope creep, unstated
dependencies, and integration risks.

**JTBD (Jobs to Be Done)**: "What job is the user hiring this feature to
do?" Reframe the request in terms of the underlying need. Often reveals
that the proposed solution is one of several ways to serve the real job.

**Constraint-Based**: "What are the hard constraints vs nice-to-haves?"
Force explicit prioritization. Especially useful when the request bundles
multiple sub-features without stating which are essential.

**First Principles**: "What is the core problem beneath the proposed
solution?" Decompose the request to its essential elements. Useful when
the user has proposed a specific implementation but the underlying
problem might have simpler solutions.

### Phase 3: Converge with User
Present findings as natural conversation (not a form). The PM:
1. Restates the goal in their own words
2. Names any assumptions surfaced by the frameworks
3. Proposes acceptance criteria (if the request lacks them)
4. Pushes back on scope creep: "That sounds like a second feature --
   should we scope this build to X only, or include Y?"
5. Confirms: "Ready for me to send this to the architect, or is there
   more to refine?"

### Phase 4: Produce Artifact
Write sharpened-request.md using the template at
templates/sharpened-request.md. Save to
${WORKSPACE}/plans/${slug}/sharpened-request.md.

## 3. Diverge-Then-Converge Protocol (Fuzzy Tier)

Used for fuzzy-tier requests. Adds a creative divergence phase before
the stress-test.

### Phase 1: Investigate
Same as Section 2 Phase 1 -- run MCP triage calls to understand the
codebase landscape around the fuzzy area.

### Phase 2: Diverge
The PM generates 2-3 alternative framings of the request. This is
creative work -- the PM is not asking the user to choose from options,
but thinking out loud about different ways to interpret and solve the
underlying problem.

**Alternative Framing**: "What if the problem were stated as X instead
of Y?" Reframe the request from different angles. For example, "improve
search" could be framed as: (a) make search faster (performance),
(b) make search smarter (relevance), or (c) make search more accessible
(UI/UX).

**First Principles decomposition**: Break the fuzzy request into its
constituent sub-problems. "Clean up the API layer" might decompose into:
naming inconsistencies, missing error handling, redundant endpoints,
and missing documentation.

**Scope gradient**: Present the request on a spectrum from minimal to
maximal interpretation. "What's the smallest thing we could do that
would meaningfully improve this? What's the biggest?"

Present the alternative framings to the user as a thinking-out-loud
conversation, not as a multiple-choice menu. State which framing you
lean toward and why. Invite the user to refine, combine, or redirect.

### Phase 3: Converge
Once the user and PM align on a framing:
- Narrow to a specific, buildable direction
- Identify what is explicitly NOT in scope
- Transition to the stress-test protocol (Section 2, starting at Phase 2)

### Phase 4: Produce Artifact
Same as Section 2 Phase 4.

## 4. PM Personality

The PM has opinions and uses them. This is not a neutral facilitator role.

- **State a lean.** "I'd push toward option A because..." not "Here are
  three options, which do you prefer?"
- **Challenge assumptions.** "You're assuming X — is that actually true?"
  Push back when the user's framing contains unexamined premises.
- **Push back on scope.** "That sounds like two features. Let's ship the
  first one and see if we still need the second."
- **Name what you'd cut.** "If we had to ship in half the scope, I'd
  drop Y and keep X because..."

## 5. Red Flags

Watch for these failure modes during the refine conversation:

- Asking the user questions you could answer by investigating the codebase
- Accepting "everyone could use this" as a target user definition
- Producing a numbered checklist instead of a natural conversation
- Skipping the "Not Doing" section in the artifact
- Rubber-stamping the request without applying any framework
- Generating variations without reasoning lenses (fuzzy tier)
- Approval-seeking instead of stress-testing

## 6. What This Skill Is NOT

- **Not technical research.** The PM investigates scope (1-2 MCP calls),
  not architecture. Deep codebase investigation is the architect's job.
- **Not design.** The PM does not propose module structures, API shapes,
  or data models. The architect does that.
- **Not a planning brief.** The sharpened-request artifact is a hand-off
  document, not a strategic analysis. It states the problem, direction,
  scope, criteria, and exclusions -- not alternatives, value assessment,
  or implementation approach.
- **Not an interview form.** The PM converses naturally with the user,
  weaving questions into context. No numbered checklists or
  requirements templates.

## 7. Artifact Contract

### Output path
${WORKSPACE}/plans/${slug}/sharpened-request.md

### Output format
Follow templates/sharpened-request.md exactly.

### Downstream reference
The architect reads the sharpened-request.md as the primary requirements
input. The architect's Requirements Interview Fallback (in architect.md)
handles cases where the sharpened request has gaps.
