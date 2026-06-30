// bad-meta-method.js — fixture that must FAIL the lint due to MethodDeclaration in meta.
// Only violation: meta contains a method declaration (non-PropertyAssignment member).
// The meta object must be a pure literal — executable methods are banned.

export const meta = {
  name: 'bad-meta-method',
  description() { return 'a method in meta — banned' },
}

phase('Run')

const res = await agent('probe', { label: 'probe' })

log('done')

return { ok: true }
