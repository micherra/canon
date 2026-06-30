// bad-nonliteral-meta.js — fixture that must FAIL the lint due to non-literal meta export.
// Only violation: meta contains a function call in its value (non-pure-literal).

const getDescription = () => 'a dynamic description'

export const meta = {
  name: 'bad-nonliteral-meta',
  description: getDescription(),
}

phase('Run')

const res = await agent('probe', { label: 'probe' })

log('done')

return { ok: true }
