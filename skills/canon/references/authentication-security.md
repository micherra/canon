# Authentication & Security Domain

## Mental Models

**Authentication Is Identity, Authorization Is Permission** — These are two different problems that are frequently conflated. Authentication answers "who is this caller?" Authorization answers "is this caller allowed to do this?" A valid session proves identity; it does not grant any specific right. Mixing them produces systems where presence of a token becomes a permission — the classic "logged-in users can do anything" bug. Design the two as distinct layers.

**Every Credential Is a Liability** — Passwords, API keys, session tokens, OAuth refresh tokens, JWTs. Each one is a bearer instrument: whoever holds it is the user. Storage, transport, rotation, and expiry are all surface area. The least-risk credential is the one you never hold: delegate to platform identity (OIDC, WebAuthn, mTLS) when you can. The shortest-lived credential you can get away with is the right one.

**Trust Boundaries Are Where Bugs Live** — Serialization, deserialization, format conversion, and context changes between systems are where authentication bypasses hide. JWT parsers that accept `alg: none`, cookies that cross subdomains, redirect URLs that get normalized differently by different parsers — the boundary is the attack surface. Whenever a credential crosses a boundary, treat it as untrusted input that needs revalidation.

## Decision Frameworks

**Session model selection** — Use server-side sessions (opaque token → server lookup) when you need to revoke on demand, track per-session state, or keep the token small. Use JWTs when you have stateless scale-out needs and can accept the revocation lag until expiry. Do not use JWTs for long-lived login sessions without a paired server-side blocklist — the "can't revoke" property is a feature only when sessions are short.

**Credential storage** — Passwords: slow hash (argon2, bcrypt, scrypt), never sha256. Secrets at rest: KMS-backed, never in code or config files. OAuth tokens: encrypted at the app layer even when the DB is already encrypted (defense in depth). Per-user secrets (API keys): hash-on-store so you can verify but never display. The table of plaintext secrets is a future breach.

**Authorization model** — Roles are a coarse hammer; attribute-based (ABAC) or relationship-based (ReBAC) models handle the cases roles can't. Start with a permission check at every boundary (API handler, service call, DB query). Resist the urge to push auth checks into middleware alone — middleware enforces policy breadth, but per-operation checks enforce policy depth. Both.

## Failure Modes

**Timing oracles** — Password checks, token lookups, and secret comparisons that use naive equality leak information via timing. The classic fix (`constant_time_compare`) only closes the comparison; it does not close differences in how long the lookup took before the compare. Treat all lookups of user-controlled keys as timing-sensitive paths.

**Trusting client-side checks** — UI hides a button when `role !== "admin"` and the API does not re-check on the POST. The UI is a hint, not a boundary. Every sensitive action needs server-side authorization, even if it "can't be reached" from the UI.

**Redirect / callback confusion** — OAuth `redirect_uri` validation that accepts `https://evil.com/good.example.com/` because the matcher is substring-based. Password reset URLs with tokens that don't bind to the originating session. Open redirects that allow phishing users back through the legitimate domain. The redirect target is part of the auth protocol — validate it like auth input.

**Credential rotation that does not actually rotate** — A password change that does not invalidate existing sessions. An API key rotation that keeps the old key valid. A forced logout that only clears cookies client-side. Rotation without invalidation is rotation theater.

## Guardrails

**Custom crypto** — You should understand your crypto primitives. If you are implementing your own hash function, your own token format, your own signing scheme, or your own encryption mode, you've gone too far. Use the platform or a vetted library. "We rolled our own for performance" is almost always a bug factory.

**Permission sprawl** — You should have fine-grained permissions. If you have a thousand distinct permission strings and no one can tell which of them any given endpoint requires, you've gone too far. Group permissions into named roles or scopes at the policy layer; the grain at the enforcement layer should match real-world decisions, not individual endpoint names.

**Secret hygiene drift** — You should rotate and audit secrets. If you have a doc listing "service X was last rotated in 2019" or a `.env.example` in the repo with real-looking values, you're leaking. Secrets belong in a secret manager with audit logs, not in docs or fixtures or git history.

**Audit log as afterthought** — You should log security-relevant events. If your audit log is the same as your application log, filtered post-hoc, you've under-invested. Authentication events, authorization failures, permission changes, and secret access belong in an immutable, separately-retained log stream.
