# Diagnosis Domain

## Mental Models

**The Bug Is 90% Solved Once You Have the Right Feedback Loop** — Before touching code, build a loop that reproduces the problem reliably and shows when it's fixed. A feedback loop has three parts: the trigger condition (what action causes the problem?), the observable symptom (what does failure look like?), and the confirmation signal (how will you know it's fixed?). Without the loop you're guessing — you might fix the wrong thing, or fix the right thing without knowing it. If the problem can't be reproduced, note that explicitly; log-based or artifact-based diagnosis is slower, but it still requires a symptom you can observe and a confirmation you can check.

**Hypotheses Before Experiments** — Generate 3-5 ranked hypotheses before running any test. Each hypothesis should name the suspected component, the suspected mechanism ("X fails because Y"), and one falsification test (one command or check that would eliminate the hypothesis). Running experiments without hypotheses is random-walk debugging: each change modifies state and makes the next observation harder to interpret. The ranking matters — test the easiest-to-falsify hypothesis first, not the most likely.

## Decision Frameworks

**Feedback loop selection** — Match the loop to the bug type. Logic error: a unit test that exercises the exact code path. Integration failure: a minimal end-to-end test that crosses the broken boundary. Timing or race condition: a test with controlled scheduling or log-based observation. Performance regression: a benchmark with an isolated workload. Wrong loop wastes time in proportion to how expensive its iteration cycle is: a minute-long integration test for a logic bug costs ten minutes before you've formed a hypothesis.

**Hypothesis ranking** — Rank by three criteria in order: (1) ease of falsification (can you disprove it in 30 seconds?), (2) likelihood given the symptom, (3) blast radius if true. Test the easiest-to-falsify hypothesis first even if it seems unlikely. Eliminating cheap hypotheses fast is more efficient than confirming expensive ones. If the easiest-to-falsify hypothesis is also the most likely, it should be first. If it's unlikely, it still goes first — ruling it out takes 30 seconds.

## Failure Modes

**Random-walk debugging** — Changing things without a hypothesis. Each change modifies state, making the next observation harder to interpret. You can observe a symptom disappear without understanding why, which means you won't catch it when it returns in a different form. Structured triage exists for a reason: reproduce, localize, reduce, fix, guard. Skipping the "localize" step is where random walks start.

**Missing post-mortem handoff** — The bug is fixed but the systemic cause is not addressed: missing test coverage for this code path, an unclear API contract that made the misuse possible, absent monitoring that would have caught it earlier. The same class of bug recurs. After fixing, ask: what architectural change would have prevented this class of bug? If the improvement is small enough to be a single task, propose it. If it's a design-level concern, surface it so it doesn't get forgotten.

## Guardrails

**Time-box hypothesis testing** — If a hypothesis hasn't been confirmed or eliminated in 10 minutes, move to the next one. Stalling on one hypothesis is usually a sign of insufficient feedback loop (the experiment isn't actually falsifying the hypothesis) or scope creep (you're debugging the hypothesis's component, not the original symptom). When the time-box expires, record what you found and move on.

**Document the diagnosis path** — Record which hypotheses were tested and what was found, even the ones that were eliminated. This prevents re-testing the same hypothesis after a context switch. It also provides value to the next person who encounters the same symptom — a documented elimination is faster than re-deriving it.
