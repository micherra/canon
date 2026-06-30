// bad-ts-syntax.js — fixture that must FAIL the lint due to TypeScript syntax.
// Only violation: TypeScript type annotation on a variable.

export const meta = {
  name: 'bad-ts-syntax',
  description: 'Fixture with TypeScript syntax — must fail lint.',
}

phase('Run')

// TypeScript type annotation — not valid in plain JS workflow scripts
const x: string = 'hello'

const res = await agent('say hello', { label: 'probe' })

log('done')

return { ok: true, x }
