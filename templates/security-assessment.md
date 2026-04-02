---
template: security-assessment
description: >-
  Standardized output for the canon-security agent. Records vulnerability
  findings ranked by severity, passed checks, and blocking status.
used-by: [canon-security]
read-by: [canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/SECURITY.md
fields:
  status: "CLEAN | FINDINGS | CRITICAL"
  agent: canon-security
  timestamp: ISO-8601
  scope: "description of what was scanned"
  findings_count: "N (X critical, X high, X medium, X low)"
---

```markdown
---
status: "{CLEAN|FINDINGS|CRITICAL}"
agent: canon-security
timestamp: "{ISO-8601}"
scope: "{scope description}"
findings_count: "{N} ({X} critical, {X} high, {X} medium, {X} low)"
---

## Security Assessment: {scope}

### Summary
Findings: {N} ({X} critical, {X} high, {X} medium, {X} low)

### Findings
<!-- Repeat this block per finding, ordered by severity (critical first) -->
<!-- Omit this section entirely if status is CLEAN -->

#### [{SEVERITY}] {Brief description}
**File:** `path/to/file.ts:{line}`
**Pattern:** {Category — e.g., SQL injection, XSS, open redirect}
**Detail:** {What the vulnerability is and how it could be exploited.}
**Recommendation:** {How to fix it.}
**Evidence URLs:** {advisories, docs, or references consulted}
**Verified Facts:** {externally supported claims relevant to this finding}
**Assumptions:** {anything not fully verified from the available evidence}

### Planned Security Controls
<!-- Only when architect plan files exist. Otherwise note "No plan files available — planned controls check skipped." -->
| Planned Control | Source | Implemented | Finding |
|----------------|--------|-------------|---------|
| {e.g., JWT validation on write endpoints} | DESIGN.md | {YES/NO} | {finding ref or "N/A"} |

<!-- If all planned controls are implemented: "All planned security controls verified in code." -->

### Passed Checks
- {Check that passed — e.g., "No hardcoded secrets found"}
- {Check that passed — e.g., "Auth middleware present on protected routes"}
```

## Rules

1. **Status mapping**: `CLEAN` = zero findings. `FINDINGS` = findings exist but none critical. `CRITICAL` = at least one critical finding.
2. **Findings ordered by severity**: critical → high → medium → low. Within same severity, order by file path.
3. **One finding per discrete vulnerability**. Do not group multiple vulnerabilities under one heading.
4. **Pattern field is required**: Use a recognized category (SQL injection, XSS, command injection, path traversal, prototype pollution, missing auth, hardcoded secret, weak token, missing CSRF, permissive CORS, sensitive data exposure, missing rate limit, debug mode, exposed port, dependency vulnerability).
5. **File field must include line number** when identifiable.
6. **Passed Checks section is required** even when findings exist — it shows what was verified clean.
7. **Evidence fields are required** when external research materially informed the finding. Omit them only if the finding is fully supported by local code evidence.
