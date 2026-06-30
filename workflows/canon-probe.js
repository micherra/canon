export const meta = {
  name: 'canon-probe',
  description: 'Harness-upgrade-stability canary — verifies workflow tool basics.',
  whenToUse: 'Run after every Canon harness upgrade to confirm the workflow runtime is functional.',
  phases: [
    { title: 'Probe', detail: 'Spawn one schema-validated agent and ingest its structured result.' },
  ],
}

// Schema for the agent output — forces StructuredOutput so the result is validated.
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

return { probe_ok: res && res.ok === true, raw: res }
