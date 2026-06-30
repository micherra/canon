// ok-isolation-return.js — positive fixture that must PASS lint (exit 0).
//
// Tests that the `isolation` ban is scoped to agent-option property keys ONLY.
// The following two uses of the word "isolation" must NOT be banned:
//   (1) a JSON-schema definition with an `isolation` property
//   (2) a return-value object literal containing `isolation`
//
// The banned construct is `isolation` as a DIRECT property key in an agent()
// argument: agent(prompt, { isolation: '...' }).  Nothing else is banned.

export const meta = {
  name: 'ok-isolation-return',
  description: 'Fixture: isolation in return values and schema definitions must NOT trigger the ban.',
}

phase('Probe')

// (1) JSON-schema definition with an `isolation` property — NOT the banned construct.
const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    isolation: { type: 'string' },
  },
  required: ['ok'],
}

const res = await agent('do something', { schema: SCHEMA, label: 'ok-isolation-return' })

log('ok-isolation-return complete')

// (2) Return-value with an `isolation` key — NOT the banned construct.
return { ok: true, isolation: 'not-a-banned-agent-option' }
