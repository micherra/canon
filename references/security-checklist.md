# Security Vulnerability Checklist

Reference material for `security`. Contains vulnerability categories and dependency audit procedures.

---

## Vulnerability Categories

### Input handling
- SQL injection (raw string concatenation in queries)
- XSS (unescaped user input in HTML/JSX)
- Command injection (user input in shell commands)
- Path traversal (user input in file paths)
- Prototype pollution (object spread from untrusted input)

### Authentication/Authorization
- Missing auth checks on routes
- Hardcoded secrets, API keys, or tokens
- Weak token generation (Math.random, predictable seeds)
- Missing CSRF protection on state-changing endpoints
- Overly permissive CORS

### Data handling
- Sensitive data in logs (passwords, tokens, PII)
- Sensitive data in error messages returned to clients
- Missing rate limiting on auth endpoints
- Unencrypted storage of sensitive fields

### Dependency risks
- Check `npm audit` or `pip audit` for known vulnerabilities
- Unnecessary dependencies that expand attack surface

### Infrastructure
- Exposed ports or services
- Missing environment variable validation
- Debug mode enabled in production configs
- Permissive file permissions

---

## Dependency Health Audit

### Outdated dependencies
- Run `npm outdated --json` (Node) or `pip list --outdated --format=json` (Python) or equivalent
- Flag dependencies more than 2 major versions behind as `medium`
- Flag dependencies more than 1 major version behind as `low`
- Skip this check if the command is unavailable or errors out

### License compliance
- Run `npx license-checker --json` (Node) or `pip-licenses --format=json` (Python) or equivalent
- Flag any copyleft licenses (GPL, AGPL) in a project not already using that license as `high`
- Flag unknown or missing licenses as `medium`
- If the license checker tool is not installed, skip with a note: "License check skipped — install license-checker for compliance analysis"

### Unnecessary dependencies
- Check `package.json` dependencies against actual imports in source files using Grep
- Flag dependencies imported by zero source files as `low` — "unused dependency: {name}"
- Do NOT flag devDependencies that are only used in build/test tooling (eslint, prettier, vitest, jest, typescript, etc.)

### New dependency justification (build pipeline only)
- If `${base_commit}` is available, compare current `package.json`/`requirements.txt` against `git show ${base_commit}:package.json`
- For each newly added dependency, flag as `info`: "New dependency: {name} — verify it's necessary and actively maintained"
- Skip this check for standalone scans (no base_commit)

---

## Exclusions & Precedents

These are known false-positive classes. Per Canon's no-context-downgrade rule (`agents/security.md` Step 4), do NOT downgrade the severity of a genuinely exploitable finding. Instead, route a finding that falls into one of these classes to `info` severity — recorded and auditable, not silently dropped (stock excludes these outright; Canon records them at `info`).

### Hard Exclusions

Route findings in these classes to `info` severity rather than reporting them above `info`:

1. **Denial of Service (DOS) / resource exhaustion** — DOS vulnerabilities and resource exhaustion attacks.
2. **Secrets secured on disk** — Secrets or credentials stored on disk if they are otherwise secured.
3. **Rate limiting** — Generic/DOS-oriented rate limiting concerns (e.g., on read-only public endpoints) or service overload scenarios. **Exception**: missing rate limiting on authentication or credential endpoints (login, token issuance, password reset) remains an ACTIONABLE finding under the "Data handling" category above and is NOT downgraded by this exclusion.
4. **Memory/CPU exhaustion** — Memory consumption or CPU exhaustion issues.
5. **Non-security-critical input validation** — Lack of input validation on non-security-critical fields without proven security impact.
6. **GitHub Action input sanitization** — Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via untrusted input.
7. **Lack of hardening** — A lack of hardening measures. Code is not expected to implement all security best practices; only flag concrete vulnerabilities.
8. **Theoretical race/timing attacks** — Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is concretely problematic.
9. **Outdated third-party libraries** — Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
10. **Memory safety in memory-safe languages** — Memory safety issues such as buffer overflows or use-after-free are impossible in Rust or other memory-safe languages; do not report memory safety issues for such stacks.
11. **Test-only files** — Files that are only unit tests or only used as part of running tests.
12. **Log spoofing** — Outputting un-sanitized user input to logs is not a vulnerability.
13. **Path-only SSRF** — SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
14. **User-controlled content in AI system prompts** — Including user-controlled content in AI system prompts is not a vulnerability.
15. **Regex injection** — Injecting untrusted content into a regex is not a vulnerability.
16. **Regex DOS** — Regex denial-of-service concerns.
17. **Findings in docs/markdown files** — Insecure documentation; do not report any findings in documentation files such as markdown files. A lack of audit logs is not a vulnerability.

### Precedents

Established adjudication decisions that resolve commonly flagged patterns:

1. **Plaintext high-value-secret logging IS a vulnerability; URL logging is safe** — Logging high-value secrets in plaintext is a vulnerability. Logging URLs is assumed to be safe.
2. **UUIDs are unguessable** — UUIDs can be assumed to be unguessable and do not need to be validated.
3. **Environment variables and CLI flags are trusted** — Attackers are generally not able to modify them in a secure environment. Any attack that relies on controlling an environment variable is invalid.
4. **Resource leaks are not valid findings** — Resource management issues such as memory or file descriptor leaks are not valid security findings.
5. **Low-impact web vulnerabilities only at extremely high confidence** — Subtle or low-impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution, and open redirects should not be reported unless they are extremely high confidence.
6. **React/Angular are generally secure against XSS** — These frameworks do not need to sanitize or escape user input unless using `dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`, or similar unsafe methods.
7. **GitHub Action vulnerabilities need a concrete attack path** — Most vulnerabilities in GitHub Action workflows are not exploitable in practice. Before flagging, ensure it is concrete with a very specific attack path.
8. **Client-side auth absence is not a vulnerability** — A lack of permission checking or authentication in client-side JS/TS code is not a vulnerability; the backend is responsible for validation.
9. **MEDIUM only if obvious and concrete** — Only include MEDIUM findings if they are obvious and concrete issues.
10. **Notebook vulnerabilities need a concrete path** — Most vulnerabilities in IPython notebooks (`*.ipynb` files) are not exploitable in practice. Before validating, ensure it is concrete with a specific attack path where untrusted input can trigger the vulnerability.
11. **Logging non-PII is not a vulnerability** — Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report logging vulnerabilities if they expose secrets, passwords, or PII.
12. **Shell-script command injection only if concrete untrusted input path** — Command injection vulnerabilities in shell scripts are generally not exploitable in practice since shell scripts generally do not run with untrusted user input.

### Authoring-time confidence bar

Only surface a finding above `info` when you are >80% confident it is concretely exploitable (a ≥8/10 confidence bar). Lower-confidence items route to `info` with a verification note.
