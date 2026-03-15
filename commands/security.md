---
description: Security scan using Canon principles
argument-hint: [file-path | --staged | --full]
allowed-tools: [Read, Glob, Grep, Bash, Agent]
---

Standalone security scan using the canon-security agent. Can be run independently outside the build workflow.

## Instructions

### Step 1: Determine scope

Parse ${ARGUMENTS}:

- **No arguments** or `--staged`: Scan staged changes
  ```bash
  git diff --cached --name-only
  ```
- **File path or directory**: Scan specific files
  ```bash
  find ${ARGUMENTS} -type f -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" | head -100
  ```
- **`--full`**: Scan entire project (excluding node_modules, .git, etc.)
  ```bash
  find . -type f \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" \) -not -path "*/node_modules/*" -not -path "*/.git/*" | head -200
  ```

### Step 2: Spawn security agent

Launch the canon-security agent as a sub-agent with the file list.

"Scan the following files for security vulnerabilities: {file list}. Apply Canon security principles. Produce a security assessment."

### Step 3: Present results

Display the security assessment to the user. Highlight critical and high severity findings prominently.

If critical findings exist, recommend addressing them before committing or merging.
