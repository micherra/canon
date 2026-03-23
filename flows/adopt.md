---
name: adopt
description: Scan codebase for principle coverage, report violations, optionally fix

states:
  scan:
    type: single
    agent: canon-researcher
    role: adoption-scan
    transitions:
      done: fix
      no_violations: done
      blocked: hitl

  fix:
    type: parallel-per
    agent: canon-fixer
    role: violation-fix
    iterate_on: violation_groups
    max_iterations: 2
    stuck_when: same_violations
    skip_when: no_fix_requested
    transitions:
      done: rescan
      cannot_fix: done
      blocked: hitl

  rescan:
    type: single
    agent: canon-researcher
    role: adoption-scan
    transitions:
      done: done
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### scan
Scan the codebase for Canon principle applicability. Target directory: ${directory}.

1. Discover source files: glob `**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,tf,sql}`, exclude `node_modules/`, `.git/`, `dist/`, `build/`, `.canon/`. If file count > 500, warn the user and suggest narrowing the scan.
2. Load principles from `.canon/principles/` (subdirectories `rules/`, `strong-opinions/`, `conventions/`) or `${CLAUDE_PLUGIN_ROOT}/principles/`. Filter by severity: ${severity_filter}.
3. For each file, infer the architectural layer from its path and match against principle scopes.
4. Analyze by principle (file count, directory count, severity) and by directory (rule/opinion/convention counts).
5. Produce a tiered remediation report (Tier 1: rules, Tier 2: strong-opinions, Tier 3: conventions) with top violation directories, most broadly applicable principles, and recommended actions.

Save report to ${WORKSPACE}/plans/${slug}/ADOPTION-REPORT.md. Top N: ${top_n}.

If no rule-severity violations found, report `no_violations`.

### fix
Mode: violation-fix. Violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}. Preserve behavior, verify with tests.

### rescan
Re-scan codebase after fixes. Same process as scan. Save updated report to ${WORKSPACE}/plans/${slug}/ADOPTION-REPORT.md.
