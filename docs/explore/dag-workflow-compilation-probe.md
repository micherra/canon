# DAG → Workflow Compilation Probe — Findings

**Status: Resolved — THESIS HOLDS.** No blockers. Two design implications for the
eventual compiler are recorded below.

## Purpose

Canon's own DAG-execution protocol (`references/dag-execution-protocol.md`) is a
*manual git checklist a human/orchestrator runs* — the automated wave-lifecycle
helpers it once had (`createWaveWorktrees`/`mergeWaveResults`/`cleanupWorktrees`)
were removed in PR #167/#180 and never rebuilt. Meanwhile `docs/explore/workflow-integration/SYNTHESIS.md`
names `canon-waves` (feature #12, Increment 5) — "one saved workflow taking
task-dag-shaped args, worker-prompt worktrees, merge-agent node" — as the
harness-native replacement, but gates it on "merge-agent validated" evidence that
didn't exist yet.

The question this probe answers: **can a real Canon build DAG be compiled into,
and executed as, a `Workflow`-tool script — with genuine parallel worker commits
and a genuine `--no-ff` merge — or does the sandboxed script body make that
structurally impossible?** If yes, `canon-waves` has empirical footing six
increments early. If no, the blocker is named precisely enough to route to the
Inc-1 fallback (`ingest_workflow_run` + orchestrator-side merge).

## What was built

One lint-passing, deterministic script, `workflows/dag-compile-probe.js`,
branched on `args.rung`:

- **Rung 1 (`args.rung === 'tail'`)** — a `pipeline()` over three read-only
  `agent()` nodes shaped like the tail of a build (context-sync → ship → learn),
  each returning a structured `{status, note}` verdict. No code-writing agents;
  proves `pipeline()` compiles and the orchestrator can route on a structured
  return.
- **Rung 2 (`args.rung === 'parallel'`)** — `parallel()` fans out two
  `canon:engineer` worker nodes, each writing one disjoint file and committing
  it via `git -C <worktree>` into an **orchestrator-pre-created**, Canon-owned
  task worktree (never the tool's `isolation` option). A barrier follows; a
  single merge-agent node then runs `git -C <build-worktree> merge --no-ff
  <branchA> <branchB>`.

Both rungs share one in-script `VERDICT` JSON-Schema const (`{status: 'ok' |
'blocked' | 'partial', note}`) — defined once, validated natively via
`agent({schema})`, no parsing and no schema *library* added under
`mcp-server/src/shared/`. Worktree creation is entirely the orchestrator's job;
the script body only ever consumes paths passed in via `args`.

## The decisive gate: A3 pre-flight

The whole Rung-2 thesis rests on one previously-untested claim (probe-matrix A3
in `references/workflow-probe-matrix.md`): *can a workflow subagent commit into
a Canon-owned worktree via `Bash`/`git -C`?* The `Workflow` script body is
sandboxed (no filesystem, no Node, no MCP — confirmed by
`docs/explore/workflow-integration/workflow-tool-spec.md` and corroborated by
`hooks/workflows-lint.sh`'s ban list), so if a spawned subagent also lacked
`Bash`, Rung 2 would be dead on arrival. The architect (no `Workflow` tool
grant) could not test this itself, so per root `CLAUDE.md`'s probe-delegation
clause the orchestrator ran a minimal ~15-line pre-flight before the full
Rung-2 script was built.

**First attempt (run `wf_b2091017`): not a capability failure.** `args.wt`
arrived as the literal string `"undefined"` — the args value was unsubstituted
in that call — so `git -C undefined` resolved to the real repository on
`main`. The spawned `canon:engineer` node correctly refused to commit onto
production main, cleaned up, and left the tree clean. This is exactly the
fail-closed behavior the fixture should produce on a bad path; it did not
answer A3.

**Root cause, fixed once and for all rungs:** `args` arrives inside the
`Workflow` sandbox as a **JSON string**, not a parsed object. `args.rung` reads
as `undefined` unless parsed first. `workflows/dag-compile-probe.js` fixes this
with one line: `const A = typeof args === 'string' ? JSON.parse(args) : (args
|| {})`.

**Second attempt (run `wf_29c68325`): GREEN.** With the parsing fix, the
subagent had `Bash` and `git`, ran a safety check
(`git -C <worktree> rev-parse --show-toplevel`, comparing against the expected
path before touching anything), then committed `de0ce46c` into the
Canon-owned throwaway worktree. The orchestrator independently verified this
against git: the worktree's `HEAD` had advanced, and `main` was untouched.

**Conclusion (A3 resolved): a `Workflow` subagent CAN commit into a
Canon-owned worktree via `git -C`, without the tool's `isolation` option.**
This is the load-bearing fact the rest of the probe depends on.

## Rung 1 — tail pipeline (run `wf_2ecc69aa-8ed`)

Returned `{rung: "tail", status: "ok"}`. All three pipeline stages
(context-sync → ship → learn shapes) returned structured `ok` verdicts.
**3 agents, wall-clock 19.2s (19208ms).** This proves `pipeline()` compiles to
a working script and that the harness returns a structured, routable verdict —
with zero code-writing agents involved.

## Rung 2 — parallel implement DAG + merge (run `wf_c83f96f1-7d0`)

Returned `{rung: "parallel", status: "ok"}`. **3 agents (2 parallel workers + 1
merge node), wall-clock 36.6s (36642ms).**

- Worker A committed `045bd581` (`probe-a.txt`) on `canon-task/A`.
- Worker B committed `4022abf9` (`probe-b.txt`) on `canon-task/B`.
- Both committed into orchestrator-pre-created Canon-owned worktrees.
- The merge node ran `git -C <build-worktree> merge --no-ff canon-task/A
  canon-task/B`, producing merge commit `a0ca51f4`.

**Independently verified by the orchestrator against git** (not taken on the
agent's word): merge commit `a0ca51f4` has **3 parents** — base `5684697` plus
`045bd581` and `4022abf9` — confirming a genuine `--no-ff` octopus merge, not a
fast-forward or a fabricated status. Both `probe-a.txt` and `probe-b.txt` are
present on the merged tree. **Zero conflicts**, as expected from the disjoint-file
fixture design.

**Boundary gate:** the orchestrator ran `hooks/dead-wire-gate.sh` against the
merged build worktree after the `Workflow` call returned, and it exited **0**.
This is the proof point for the "deterministic Bash gate composes at a
Workflow segment boundary" claim — the gate is not, and cannot be, run from
inside the sandboxed script body; it runs orchestrator-side on the merged
result.

## Structural findings

- **The script body is sandboxed; all effects are pushed to the edges.** No
  filesystem, no Node, no MCP access inside the body (`PROBE-FINDINGS.md` S3).
  Every git/disk/merge effect in this probe lives inside a spawned `agent()`
  node; every durable journaling call (`log_step`/`log_decision`) and every
  deterministic Bash gate lives orchestrator-side, at the segment boundary
  after the `Workflow` call returns. This cleanly answers what would otherwise
  be an open question (friction #3, journaling/gates inside a compiled DAG):
  they don't move inside the sandbox — they stay exactly where Canon's
  existing orchestrator protocol already puts them.
- **No mid-run HITL primitive** (friction #1) — confirmed by the tool spec, not
  contradicted by anything observed in this probe. A gated multi-segment build
  compiles to *N* separate `Workflow` invocations, with HITL gates living
  between segments, not inside one. This probe exercised only single-segment
  runs (Rung 1, Rung 2), so it does not itself demonstrate a multi-gate build —
  it demonstrates that each individual segment works, which is the
  prerequisite.
- **Merge ownership stays with Canon, not the tool** (friction #2) — confirmed.
  Canon-owned worktrees are supplied by path via `args`; the merge is performed
  by an ordinary Canon agent node running `git -C ... merge --no-ff`; the
  tool's `isolation` option is never used (banned by `workflows/CLAUDE.md` and
  root `CLAUDE.md` — it auto-merges to the calling branch and would bypass
  Canon's controlled merge lifecycle). The parallel-DAG execution path this
  displaces has been dormant/doc-only since PR #167 — this build is purely
  additive; there is no running merge code being regressed.

## Head-to-head: compiled `Workflow` vs. the current DAG protocol

| Axis | Compiled `Workflow` (this probe, measured) | Current `dag-execution-protocol.md` (manual) |
|---|---|---|
| **Wall-clock** | Rung 1: 19.2s (19208ms) / 3 agents. Rung 2: 36.6s (36642ms) / 3 agents (2 workers + 1 merge). | Not measured — a human/orchestrator-run checklist; no automated baseline exists to compare against, because the wave-lifecycle helpers were removed in PR #167 and never replaced with running code. |
| **Merge correctness** | `--no-ff` octopus merge, 3 parents (git-verified), both task files present on the merged tree, zero conflicts. Verified independently by the orchestrator against git, not taken on the agent's self-report. | Manual `git merge --no-ff` steps run by hand per `references/dag-execution-protocol.md`; correctness depends entirely on the human/orchestrator executing the documented steps faithfully each time — no automated verification step exists in the protocol itself. |
| **Journal / event fidelity** | Structured `{status, note}` return at each segment boundary (native `agent({schema})` validation, no parsing); orchestrator calls `log_step`/`log_decision` on that structured return, and ran a real deterministic Bash gate (`hooks/dead-wire-gate.sh`, exit 0) against the merged result. | Manual journaling — the orchestrator logs steps by hand per the standing Journal Protocol; no structured per-node return exists because there is no compiled DAG, only documented git commands. |

## Verdict: THESIS HOLDS

A Canon build DAG **can** be compiled to and executed as a `Workflow` script.
All three suspected frictions (mid-run HITL, merge ownership, journaling/gates
inside the sandbox) turned out to be small orchestrator-side bridges, not
blockers — the sandboxed-body constraint (S3) makes the bridge shape obvious
rather than making it impossible. Both rungs ran green, and the Rung-2 merge
was independently git-verified, not just self-reported by an agent.

This probe generates the evidence `docs/explore/workflow-integration/SYNTHESIS.md`
§3.4's endgame gates on — specifically the "merge-agent validated" precondition
for feature #12 `canon-waves` (Increment 5) — roughly six increments earlier
than the synthesis's own roadmap anticipated.

## Blockers

**None.** Both rungs are green, git-verified, and the boundary gate composes as
expected. Two design implications the eventual compiler MUST honor, surfaced
by this probe and now fixed in `workflows/dag-compile-probe.js`:

1. **`args` arrives as a JSON string, not a parsed object.** The first A3
   attempt (`wf_b2091017`) failed silently on an unsubstituted `"undefined"`
   path precisely because of this — a workflow reading `args.rung` (or any
   other field) directly, without parsing, will get `undefined`. The eventual
   compiler must emit a defensive parse (`typeof args === 'string' ?
   JSON.parse(args) : (args || {})`) at the top of every generated script, not
   leave it to each hand-written script to remember.
2. **The sandboxed body forces the effect-delegation pattern.** Any compiler
   emitting a DAG-to-Workflow translation must route every git/disk/journal
   effect to either a spawned `agent()` node or the orchestrator boundary —
   never into the script body itself. This is not a workaround; it is the only
   shape the sandbox permits, and this probe's clean pass/fail split (S3 body
   vs. agent-node/boundary effects) is the concrete proof that the pattern is
   sufficient, not just theoretically necessary.

**Event-backbone co-design opportunity:** a segment's structured return (the
`{status, note}` / `{rung, status, workers, merge}` shape returned here) is
itself a natural event stream. The cross-session/OTel event-backbone
exploration (Inc-0 wired in PR #491) and the eventual DAG-compiler
(`docs/explore/compilation-gradient.md`, Builds 2–4) should co-design the
segment-return schema so one structured shape serves both consumers rather
than being invented twice.

## Cross-references

- `docs/explore/workflow-integration/SYNTHESIS.md` §3.4 — the ratified
  endgame gate this probe's evidence feeds; feature #12 `canon-waves`
  (Increment 5).
- `references/workflow-probe-matrix.md` — A1/A2/A3 deferred probes; A3 is
  exactly this build's decisive gate, now resolved GREEN.
- `references/dag-execution-protocol.md` — the manual protocol this probe
  compares against; self-declares the parallel-worktree path unbacked since
  PR #167.
- `docs/explore/compilation-gradient.md` — the broader compilation-gradient
  direction this probe's evidence informs (Builds 2–4).
- `workflows/dag-compile-probe.js` — the probe script itself (throwaway,
  evidence-gathering; see its `DESIGN.md` D1–D7 for the full decision record).
