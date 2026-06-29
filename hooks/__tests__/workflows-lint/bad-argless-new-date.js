// bad-argless-new-date.js — fixture that must FAIL the lint due to argless new Date().
// Only violation: new Date() with zero args.
// Note: new Date(someArg) would be valid — only argless form is banned.

export const meta = {
  name: 'bad-argless-new-date',
  description: 'Fixture with argless new Date() — must fail lint.',
}

phase('Run')

const now = new Date()

const res = await agent('get timestamp', { label: 'probe' })

log('done')

return { ok: true, ts: now.toISOString() }
