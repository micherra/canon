// good-args-parsed.js — fixture that must PASS the workflows lint: parses `args`
// defensively before reading any field off it (see workflows/CLAUDE.md
// args-is-JSON-string contract). Same shape as bad-args-bare.js otherwise, so
// the ONLY signal distinguishing the two is the defensive-parse guard.

export const meta = {
  name: 'good-args-parsed',
  description: 'Fixture: parses args defensively before reading.',
  whenToUse: 'Lint test fixture only — never run as a real workflow.',
}

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})

phase('Probe')

const r = A.rung

log('good-args-parsed complete')

return { rung: r }
