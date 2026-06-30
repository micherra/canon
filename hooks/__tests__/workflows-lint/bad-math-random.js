// bad-math-random.js — fixture that must FAIL the lint due to Math.random() usage.
// Only violation: Math.random() call.

export const meta = {
  name: 'bad-math-random',
  description: 'Fixture with Math.random() — must fail lint.',
}

phase('Run')

const r = Math.random()

const res = await agent('pick a number', { label: 'probe' })

log('done')

return { ok: true, r }
