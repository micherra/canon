// bad-malformed.js — fixture that must FAIL the lint due to malformed JS (parse error).
// The parser should detect this via ts.parseDiagnostics.

export const meta = {
  name: 'bad-malformed',
  description: 'Fixture with malformed JS — must fail lint.',
}

// Malformed: unclosed parenthesis triggers a parse diagnostic
const broken = (((
