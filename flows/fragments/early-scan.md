---
fragment: early-scan
type: consultation
description: Security quick-scan of wave changes before next wave builds on them
agent: canon-security
role: early-scan
section: Early warnings
timeout: 5m
---

## Spawn Instructions

### early-scan
Quick security scan of wave ${wave} changes for: ${task}.
Files changed: ${wave_files}
Diff: ${wave_diff}

Flag: hardcoded secrets, SQL injection, unvalidated input, insecure defaults.
Only flag issues that next-wave implementors should know about.
Max 200 tokens. No code — advisory only.
