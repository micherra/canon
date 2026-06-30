// bad-date-now.js — fixture that must FAIL the lint due to Date.now() usage.
// Only violation: Date.now() call.

export const meta = {
  name: 'bad-date-now',
  description: 'Fixture with Date.now() — must fail lint.',
}

phase('Run')

const t = Date.now()

const res = await agent('echo ' + t, { label: 'probe' })

log('done')

return { ok: true, t }
