---
fragment: security-scan
description: Security scan with optional fix loop for critical findings
entry: security
params:
  after_done:
    type: state_id
  on_critical:
    type: state_id
    default: hitl
  fix_max_iterations:
    type: number
    default: 2

states:
  security:
    type: single
    agent: canon-security
    template: security-assessment
    transitions:
      done: ${after_done}
      critical: ${on_critical}
      blocked: hitl

  fix-security:
    type: parallel-per
    agent: canon-fixer
    role: violation-fix
    iterate_on: security_findings
    max_iterations: ${fix_max_iterations}
    stuck_when: same_violations
    transitions:
      done: security
      cannot_fix: hitl
      blocked: hitl
---

## Spawn Instructions

### security
Scan implemented code for security vulnerabilities. File list from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.

### fix-security
Mode: violation-fix. Security finding: ${item.severity} — ${item.detail} in ${item.file_path}. Preserve behavior, verify with tests.
