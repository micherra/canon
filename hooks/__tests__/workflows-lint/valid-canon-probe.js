// valid-canon-probe.js — fixture that must PASS the workflows lint (exit 0).
// Exercises: pure-literal meta, phase(), schema-validated agent(), log(), return.
// Also exercises a with-arg new Date(...) to prove argless-only detection.

export const meta = {
  name: 'canon-probe',
  description: 'Canary workflow — harness-upgrade-stability probe.',
  whenToUse: 'Run after every harness upgrade to verify workflow tool basics.',
  phases: [
    { title: 'Probe', detail: 'Run one schema-validated agent and return.' },
  ],
}

const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['ok'],
}

phase('Probe')

const res = await agent(
  'Return {"ok": true, "note": "canon-probe passed"}',
  { schema: SCHEMA, label: 'probe' },
)

log('canon-probe complete')

// A with-arg new Date(...) must NOT be flagged — only argless new Date() is banned.
const _ts = new Date(args && args.ts ? args.ts : '2026-01-01')

return { probe_ok: res && res.ok === true, raw: res }
