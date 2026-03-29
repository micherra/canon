# Security Vulnerability Checklist

Reference material for `canon-security`. Contains vulnerability categories and dependency audit procedures.

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
