// bad-args-bare.js — fixture that must FAIL the workflows lint: reads `args.rung`
// with no preceding defensive parse (see workflows/CLAUDE.md args-is-JSON-string
// contract). Otherwise lint-clean (pure-literal meta, no other banned constructs)
// so the ONLY signal is the new args-defensive-parse check.

export const meta = {
  name: 'bad-args-bare',
  description: 'Fixture: reads args.rung with no defensive parse.',
  whenToUse: 'Lint test fixture only — never run as a real workflow.',
}

phase('Probe')

const r = args.rung

log('bad-args-bare complete')

return { rung: r }
