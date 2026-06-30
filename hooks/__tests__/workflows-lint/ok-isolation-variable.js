// ok-isolation-variable.js — fixture that must PASS lint (exit 0).
//
// Tests the isolation-detection boundary: the lint bans `isolation` when it
// appears as an agent-option PROPERTY KEY ({ isolation: ... }), NOT when it
// appears as a bare variable name.  A standalone `const isolation = ...` is
// intentionally out of scope — banning it would cause false positives on any
// workflow that happens to name a variable `isolation` for unrelated purposes.
//
// Lint must:
//   - PASS (exit 0) when run on this file
//   - FAIL (exit 1, naming "isolation") when run on bad-isolation.js
// Together these two assertions lock the key-scoped detection boundary.

export const meta = {
  name: 'ok-isolation-variable',
  description: 'Fixture: a bare variable named isolation must NOT trigger the isolation ban.',
}

phase('Probe')

// A variable named "isolation" is NOT the banned construct.
// The ban targets the isolation key when passed as an agent-option property:
//   agent(..., { isolation: 'worktree' })  ← BANNED property key
// A bare variable (and its use as a value) is unrelated and stays allowed.
const isolation = 'worktree'

const res = await agent('do nothing', { label: 'ok-isolation-variable' })

log('isolation variable value: ' + isolation)

return { ok: true }
