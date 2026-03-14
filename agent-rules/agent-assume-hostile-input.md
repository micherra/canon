---
id: agent-assume-hostile-input
title: Assume Hostile Input
severity: rule
scope:
  languages: []
  layers: []
tags:
  - agent-behavior
  - security
---

The security agent treats every external input boundary as hostile. User input, API request bodies, query parameters, headers, file uploads, webhook payloads, environment variables from untrusted sources, and third-party API responses are all untrusted until validated. The security scan checks that validation exists at every boundary.

## Rationale

The most common security vulnerabilities in AI-generated code come from trusting input. An LLM generates the happy path naturally — it builds what the user asked for. It rarely adds input validation unless told to. The security agent's job is to verify that every input boundary has validation, sanitization, or escaping appropriate to how the input is used.

## Examples

**Bad — security scan misses input boundary:**

```markdown
## Security Assessment
Findings: 0
All clear!
(But the handler uses req.query.redirect directly in a Location header)
```

**Good — security scan catches input at every boundary:**

```markdown
## Security Assessment
Findings: 2

[HIGH] Unvalidated redirect in login handler
File: src/app/api/auth/login/route.ts:23
The redirectTo query parameter is used directly in res.redirect()
without validating it's a relative URL or allowed domain.

[MEDIUM] User-supplied filename in file path
File: src/services/upload.ts:15
The original filename from the upload is used in the storage path
without sanitization. Could allow path traversal.
```

## Exceptions

Internal service-to-service communication within a trusted network boundary may have relaxed validation. But the security agent should still flag the boundary and note that trust is assumed, so a future reviewer can assess whether that assumption still holds.

**Related:** `validate-at-trust-boundaries` is the architectural counterpart — it defines *where* in the system validation must occur. This principle defines the *agent behavior*: how the AI should approach input handling when writing or reviewing code.
