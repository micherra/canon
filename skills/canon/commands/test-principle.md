---
description: Test that a principle is correctly detected during review
argument-hint: <principle-id>
allowed-tools: [Read, Write, Bash, Glob, Grep, Agent]
model: sonnet
---

Generate code that intentionally violates a principle, run the reviewer against it, and verify the violation is caught. This validates that custom or modified principles actually work in the review pipeline.

## Instructions

### Step 1: Find the principle

Extract the principle ID from ${ARGUMENTS}.

If no argument provided, list available principles and ask the user which one to test.

Search for the principle file in:
1. `.canon/principles/**/*.md` (project-local)
2. `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md` (built-in)
3. `.canon/rules/*.md` (project-local agent-rules)
4. `${CLAUDE_PLUGIN_ROOT}/.claude/rules/*.md` (built-in agent-rules)

Read the full principle file — frontmatter and body.

### Step 2: Generate violating code

From the principle's `## Examples` section, identify the "Bad" example patterns. Generate a realistic test file that violates the principle. The file should:

- Be placed in a temp location that matches the principle's scope (correct layer/file pattern)
- Contain a clear, unambiguous violation
- Be realistic enough that a reviewer would flag it in a real codebase
- Be a single file, kept short (under 50 lines)

Save to `.canon/test-principle-{id}.tmp.{ext}` (use appropriate file extension for the language).

Tell the user: "Generated test file with an intentional violation of `{id}`."

### Step 3: Run the review

Use the `review_code` MCP tool to get matched principles for the test file content. Alternatively, spawn the canon-reviewer agent directly on the test file.

### Step 4: Check the result

Verify the principle was matched and the violation was flagged:

- **PASS**: The reviewer caught the violation and cited the correct principle ID.
  Show: "Test PASSED — `{id}` was correctly detected. The reviewer flagged: {violation summary}"

- **FAIL**: The reviewer did not flag the violation.
  Show: "Test FAILED — `{id}` was not detected. Possible causes:"
  - "The principle's scope (layers: {layers}, file_patterns: {patterns}) may not match the test file path"
  - "The principle's severity may be too low to trigger in this context"
  - "The violation pattern may not be specific enough for the reviewer to catch"
  Suggest: "Try `/canon:edit-principle {id}` to adjust the scope or ask Canon to explain `{id}` to see how it matches in your codebase."

### Step 5: Clean up

Delete the temporary test file:
```bash
rm .canon/test-principle-{id}.tmp.*
```

### Step 6: Summary

Show the final result:
```
## Principle Test: {id}

Result: PASS / FAIL
Principle: {title} ({severity})
Scope: layers={layers}, patterns={file_patterns}
Violation: {what was generated}
Reviewer: {caught it / missed it}
```

If PASS, suggest: "This principle is working correctly in the review pipeline."
If FAIL, suggest concrete next steps to fix the principle's scope or examples.
