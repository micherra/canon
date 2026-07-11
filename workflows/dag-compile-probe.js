// dag-compile-probe.js — evidence probe (throwaway, see DESIGN.md D1-D7).
//
// Compiles a real Canon build DAG into ONE Workflow-tool script, branched on
// args.rung, to gather decisive evidence on whether the harness Workflow
// primitive can replace Canon's bespoke DAG-execution protocol. See
// docs/explore/dag-workflow-compilation-probe.md for the findings write-up.
//
// Expected `args` shape (JSON — see the parsing note below):
//   { rung: 'tail' }
//   { rung: 'parallel', task_worktrees: [pathA, pathB],
//     task_branches: ['canon-task/A', 'canon-task/B'], build_worktree: buildPath }
//
// Worktree provisioning is the orchestrator's job (D7) — this script only
// consumes paths via args; it never creates worktrees itself (sandboxed body).
export const meta = {
  name: 'dag-compile-probe',
  description: 'Evidence probe: compiles a real Canon build DAG (tail pipeline + parallel implement/merge) into a Workflow-tool script.',
  whenToUse: 'Run via args.rung to exercise Rung 1 (tail pipeline) or Rung 2 (parallel implement + merge-agent).',
  phases: [
    { title: 'Tail', detail: 'context-sync -> ship -> learn shaped read/analysis pipeline (Rung 1)' },
    { title: 'Parallel', detail: 'two canon:engineer workers write+commit disjoint files into Canon-owned worktrees (Rung 2)' },
    { title: 'Merge', detail: '--no-ff merge of both task branches onto the build worktree (Rung 2)' },
  ],
}

// EMPIRICAL FINDING (A3 pre-flight, run wf_b2091017 -> wf_29c68325): args
// arrives in the Workflow sandbox as a JSON STRING, not a parsed object.
// Reading args.rung directly yields undefined. Parse defensively.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})

// The verdict schema is declared ONCE (D1/D2) — no mirror added under
// mcp-server/src/shared/. The orchestrator routes on the returned literals.
const VERDICT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'blocked', 'partial'] },
    note: { type: 'string' },
  },
  required: ['status'],
}

if (A.rung === 'tail') {
  // ---------------------------------------------------------------------
  // Rung 1: tail pipeline (context-sync -> ship -> learn), read-only.
  // No code-writing agents. Proves pipeline() compiles + structured return.
  // ---------------------------------------------------------------------
  phase('Tail')

  const stages = await pipeline(
    ['context-sync', 'ship', 'learn'],
    (stageName) => agent(
      `You are simulating the "${stageName}" tail stage of a Canon build for an evidence probe. Perform a READ-ONLY analysis (make no writes, run no mutating commands) and return a structured verdict: {"status":"ok","note":"<one sentence describing what the ${stageName} stage would check>"}.`,
      { schema: VERDICT, label: `tail:${stageName}`, phase: 'Tail' },
    ),
  )

  const results = stages.filter(Boolean)
  const allOk = results.length === stages.length && results.every((r) => r.status === 'ok')

  log(`Rung 1 (tail) complete: ${results.length}/${stages.length} stages returned ok`)

  return { rung: 'tail', status: allOk ? 'ok' : 'partial', stages: results }
} else if (A.rung === 'parallel') {
  // ---------------------------------------------------------------------
  // Rung 2: parallel({taskA, taskB}) into orchestrator-pre-created
  // Canon-owned worktrees, followed by a single merge-agent --no-ff node.
  // ---------------------------------------------------------------------
  const taskWorktrees = A.task_worktrees || []
  const pathA = taskWorktrees[0]
  const pathB = taskWorktrees[1]
  const taskBranches = A.task_branches || []
  const branchA = taskBranches[0] || 'canon-task/A'
  const branchB = taskBranches[1] || 'canon-task/B'
  const buildWt = A.build_worktree

  phase('Parallel')

  const workerPrompt = (wtPath, fileName, branchName) =>
    `Using Bash, first run: git -C ${wtPath} rev-parse --show-toplevel\n` +
    `Confirm the output resolves to exactly "${wtPath}" (the Canon-owned task worktree you were assigned). If it does not match, STOP and return {"status":"blocked","note":"worktree mismatch: expected ${wtPath}"} without making any changes.\n` +
    `Otherwise, write the text "dag-compile-probe" to a new file ${wtPath}/${fileName}, then run:\n` +
    `git -C ${wtPath} add ${fileName} && git -C ${wtPath} -c user.name=canon -c user.email=canon@local commit -m "probe(dag-compile): write ${fileName} on ${branchName}"\n` +
    `Return {"status":"ok","note":"<the resulting commit sha>"} on success, {"status":"blocked","note":"<the exact error output>"} otherwise.`

  const [workerA, workerB] = await parallel([
    () => agent(workerPrompt(pathA, 'probe-a.txt', branchA), {
      schema: VERDICT, agentType: 'canon:engineer', label: 'worker:A', phase: 'Parallel',
    }),
    () => agent(workerPrompt(pathB, 'probe-b.txt', branchB), {
      schema: VERDICT, agentType: 'canon:engineer', label: 'worker:B', phase: 'Parallel',
    }),
  ])

  const workers = [workerA, workerB].filter(Boolean)
  log(`Rung 2 workers complete: ${workers.length}/2 returned a result`)

  const workersOk = workers.length === 2 && workers.every((w) => w.status === 'ok')

  let merge = null
  if (workersOk) {
    phase('Merge')
    merge = await agent(
      `Using Bash, first run: git -C ${buildWt} rev-parse --show-toplevel\n` +
      `Confirm the output resolves to exactly "${buildWt}" (the Canon-owned build worktree). If it does not match, STOP and return {"status":"blocked","note":"worktree mismatch: expected ${buildWt}"} without making any changes.\n` +
      `Otherwise, run: git -C ${buildWt} merge --no-ff ${branchA} ${branchB} -m "probe(dag-compile): merge ${branchA} and ${branchB}"\n` +
      `Return {"status":"ok","note":"<the resulting merge commit sha>"} on success, {"status":"blocked","note":"<the exact error output>"} otherwise.`,
      { schema: VERDICT, agentType: 'canon:engineer', label: 'merge', phase: 'Merge' },
    )
  } else {
    log('Skipping merge: not all Rung-2 workers reported ok')
  }

  const mergeOk = merge != null && merge.status === 'ok'

  let overallStatus
  if (workersOk && mergeOk) {
    overallStatus = 'ok'
  } else if (workers.length === 0) {
    overallStatus = 'blocked'
  } else {
    overallStatus = 'partial'
  }

  return { rung: 'parallel', status: overallStatus, workers, merge }
} else {
  // Unknown/absent args.rung -> fail-closed (fail-closed-by-default). Never
  // guess which rung was intended.
  return { status: 'blocked', note: 'unknown rung' }
}
