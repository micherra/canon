// bad-isolation.js — fixture that must FAIL the lint due to isolation property.
// Only violation: isolation property in an agent options object.

export const meta = {
  name: 'bad-isolation',
  description: 'Fixture with isolation property — must fail lint.',
}

phase('Run')

const res = await agent('do something', { isolation: 'worktree', label: 'probe' })

log('done')

return { ok: true }
