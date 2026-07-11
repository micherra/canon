// canon-waves.js — generic single-wave implement substrate (SYNTHESIS Inc-5,
// Increment 1). Productized generalization of the PR #498 probe's Rung 2
// shape (workflows/dag-compile-probe.js): `parallel()` fans workers into
// Canon-owned worktrees, then a single merge-agent `--no-ff` node.
//
// Consumes a WavesArgs envelope built by the `compile_waves` MCP tool — see
// mcp-server/src/shared/lib/waves-compiler.ts. Increment 1 processes exactly
// one wave; behavior comes only from `args`, never a per-flow branch.
//
// Worktree provisioning is the orchestrator's job — this script only
// consumes paths via args; it never creates worktrees itself (sandboxed body).
export const meta = {
  name: 'canon-waves',
  description: 'General DAG single-wave implement substrate (SYNTHESIS Inc-5).',
  whenToUse: 'Run for a single-wave Canon build (task-dag.yaml with no depends_on) via a compile_waves-produced WavesArgs envelope.',
  phases: [
    { title: 'Implement', detail: 'parallel() canon:engineer workers commit into Canon-owned task worktrees' },
    { title: 'Merge', detail: '--no-ff merge of all task branches onto the build worktree' },
  ],
}

// `args` arrives in the Workflow sandbox as a JSON STRING, not a parsed
// object (PR #498 finding) — parse defensively before any other access.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})

// The verdict schema is declared ONCE here (no mirror under mcp-server/src/shared/).
const VERDICT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'blocked', 'partial'] },
    note: { type: 'string' },
  },
  required: ['status'],
}

// ---------------------------------------------------------------------------
// Up-front arity/shape check (probe finding #3) — fail closed BEFORE building
// any prompt. Never guess at a malformed or out-of-scope envelope.
// ---------------------------------------------------------------------------
function validateArgsShape(a) {
  if (!Array.isArray(a.waves) || a.waves.length < 1) {
    return 'malformed args: waves must be a non-empty array'
  }
  if (a.waves.length > 1) {
    return 'multi-wave out of scope for increment 1'
  }
  if (!a.build_worktree) {
    return 'malformed args: build_worktree is required'
  }
  const wave = a.waves[0]
  const tasks = wave && wave.tasks
  if (!Array.isArray(tasks) || tasks.length < 1) {
    return 'malformed args: waves[0].tasks must be a non-empty array'
  }
  for (const task of tasks) {
    if (!task || !task.task_id || !task.worktree_path || !task.branch || !task.prompt_seed) {
      return `malformed args: task missing required field (task_id/worktree_path/branch/prompt_seed): ${JSON.stringify(task)}`
    }
  }
  return null
}

const shapeError = validateArgsShape(A)
if (shapeError) {
  return { status: 'blocked', note: shapeError }
}

const wave = A.waves[0]
const tasks = wave.tasks
const buildWorktree = A.build_worktree
const mergeOrder = Array.isArray(A.merge_order) ? A.merge_order : tasks.map((t) => t.branch)

phase('Implement')

const workerResults = await parallel(
  tasks.map((task) => () =>
    agent(task.prompt_seed, {
      schema: VERDICT,
      agentType: 'canon:engineer',
      label: 'worker:' + task.task_id,
      phase: 'Implement',
    }),
  ),
)

const workers = workerResults.filter(Boolean)
if (workers.length < workerResults.length) {
  log(`canon-waves: ${workerResults.length - workers.length} worker(s) returned no result`)
}

const allOk = workers.length === tasks.length && workers.every((w) => w.status === 'ok')

let merge = null
if (allOk) {
  phase('Merge')

  const branches = tasks.map((t) => t.branch)
  const mergeBranches = mergeOrder.length > 0 ? mergeOrder : branches

  merge = await agent(
    `Using Bash, first run: git -C ${buildWorktree} rev-parse --show-toplevel\n` +
      `Confirm the output resolves to exactly "${buildWorktree}" (the Canon-owned build worktree). If it does not match, STOP and return {"status":"blocked","note":"worktree mismatch: expected ${buildWorktree}"} without making any changes.\n` +
      `Otherwise, run: git -C ${buildWorktree} merge --no-ff ${mergeBranches.join(' ')} -m "canon-waves: merge ${mergeBranches.join(', ')}"\n` +
      `Return {"status":"ok","note":"<the resulting merge commit sha>"} on success, {"status":"blocked","note":"<the exact error output>"} otherwise.`,
    {
      schema: VERDICT,
      agentType: 'canon:engineer',
      label: 'merge',
      phase: 'Merge',
    },
  )
} else {
  log('canon-waves: skipping merge — not all Implement workers reported ok')
}

const mergeOk = merge != null && merge.status === 'ok'

let overallStatus
if (allOk && mergeOk) {
  overallStatus = 'ok'
} else if (workers.length === 0) {
  overallStatus = 'blocked'
} else {
  overallStatus = 'partial'
}

log(`canon-waves complete: status=${overallStatus}`)

return { status: overallStatus, waves: [{ wave: wave.wave, tasks: workers }], merge }
