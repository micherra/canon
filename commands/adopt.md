---
description: Scan codebase for principle coverage and produce a prioritized remediation plan
argument-hint: [directory] [--top N] [--severity rule|strong-opinion|convention] [--fix]
allowed-tools: [Read, Glob, Grep, Agent]
model: sonnet
---

Scan a directory for Canon principle applicability across all source files. Identifies which principles apply most broadly, finds directories with the most violations, and produces a prioritized remediation plan. Optionally spawns canon-refactorer on the top violations.

## Instructions

### Step 1: Parse arguments

From ${ARGUMENTS}, extract:
- **Directory**: First non-flag argument, defaults to `.` if not provided
- `--top N`: Number of top violation files to highlight (default: 10)
- `--severity LEVEL`: Minimum severity to include (default: `convention` — includes everything)
- `--fix`: If present, spawn canon-refactorer on Tier 1 files after generating the report

### Step 2: Discover source files

Glob for source files in the target directory: `**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,tf,sql}`. Exclude `node_modules/`, `.git/`, `dist/`, `build/`, `.canon/`.

If the file count exceeds 500, warn the user and suggest narrowing the scan to a subdirectory.

### Step 3: Match principles to each file

First, read all principle files from `.canon/principles/` and its subdirectories `rules/`, `strong-opinions/`, `conventions/` (or fall back to `${CLAUDE_PLUGIN_ROOT}/principles/` and its subdirectories). Extract frontmatter for each: `id`, `severity`, `scope.layers`, `scope.file_patterns`.

For each source file, determine which principles apply by:
1. Inferring the architectural layer from the file path
2. Matching `scope.layers` (empty = universal) and `scope.file_patterns` (empty = matches all)
3. Filtering by the `--severity` minimum if provided

Collect results into mappings:
- `file → [matched principles]`
- `principle → [matched files]`
- `directory → [matched principles by severity]`

Show progress to the user (e.g., "Scanning... 50/200 files").

### Step 4: Analyze results

**By principle** — for each matched principle, count:
- How many files it applies to
- How many distinct directories
- Its severity level

Sort by: severity (rules first), then by file count (descending).

**By directory** — for each directory, count:
- Total rule-severity principle matches
- Total strong-opinion matches
- Total convention matches
- Number of source files

Sort by rule count (descending), then strong-opinion count.

### Step 5: Produce the remediation plan

Generate a tiered report:

```markdown
## Canon Adoption Report

### Scan Summary
- Directory: ${DIRECTORY}
- Files scanned: N
- Unique principles matched: N
- Severity breakdown: N rules, N strong-opinions, N conventions

### Tier 1: Rule-Severity Principles (Must Fix)
Files where rule-severity principles apply. These must be addressed.

| File | Rules | Principles |
|------|-------|------------|
| src/api/orders.ts | 1 | secrets-never-in-code |

### Tier 2: Strong-Opinion Principles (Should Fix)
Files where strong-opinion principles apply. Follow unless justified.

| File | Count | Principles |
|------|-------|------------|
| ... | ... | ... |

### Tier 3: Convention Principles (Nice to Have)
Convention-level principles that could be adopted.

| File | Count | Principles |
|------|-------|------------|
| ... | ... | ... |

### Top Violation Directories
Directories with the highest density of applicable principles:

| Directory | Rules | Opinions | Conventions | Files |
|-----------|-------|----------|-------------|-------|
| src/api/ | 12 | 8 | 5 | 6 |

### Most Broadly Applicable Principles
Principles that apply across the most files:

| Principle | Severity | Files | Directories |
|-----------|----------|-------|-------------|
| simplicity-first | strong-opinion | 45 | 12 |

### Recommended Actions
1. Start with Tier 1 — ask Canon to review files with rule-severity principles
2. For Tier 2 — schedule a principle-by-principle sweep starting with the most broadly applicable
3. For Tier 3 — adopt conventions incrementally during regular development
4. Consider running `/canon:explain <principle-id>` on unfamiliar principles
```

### Step 6: Save the report

```bash
mkdir -p .canon
```

Save the report to `.canon/adoption-report.md`. Tell the user where it was saved.

### Step 7: Optionally spawn refactorer

If `--fix` was passed, spawn canon-refactorer on each Tier 1 file with its specific violations.

For each file in Tier 1 (up to `--top N`), spawn a canon-refactorer agent:
- Pass the file path, the applicable rule-severity principle IDs, the full principle body text, and a description of the expected violation
- Include the matched principle bodies directly so refactorers do NOT need to re-load principles from disk
- Each refactorer gets one file — this follows fresh context

Report the refactorer results as they complete.
