---
id: agent-working-environment
title: Derive Working Environment from Spawn Prompt
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - coordination
  - engineer
  - reviewer
  - shipper
  - tester
---

When spawned with a `Working directory:` path, derive all environment paths from it immediately. Do not spend turns exploring the filesystem or guessing paths.

## Rule

At the start of execution, establish three paths from the spawn prompt:

1. **Working directory** — the `Working directory:` value. All file reads, writes, and shell commands execute here.
2. **Workspace root** — one directory level above the working directory (the parent of `worktree/`). Workspace artifacts (summaries, reviews) go here.
3. **Build commands** — for TypeScript projects, use `npm --prefix {working_directory}/mcp-server` (or whatever subfolder contains `package.json`). Do not `cd` into subdirectories to run npm.

Use these paths explicitly in every command. Do not rely on implicit CWD inheritance across tool calls.

## Rationale

4/4 code-executing agent spawns across 3 agent types (engineer, reviewer, shipper) burned turns re-deriving their working environment — running `ls`, `find`, or `pwd` to figure out where they are. The orchestrator already provides the worktree path; agents should use it directly without exploration.

## Examples

**Good** — immediate path use:
```
# First tool call uses the path from spawn prompt
npm --prefix /Users/.../worktree/mcp-server run build
```

**Bad** — wasted exploration:
```
# Turn 1: Where am I?
pwd
# Turn 2: What's in here?
ls
# Turn 3: Where's the package.json?
find . -name package.json
# Turn 4: Finally running the build
cd mcp-server && npm run build
```

## Exceptions

- If the spawn prompt does not include a `Working directory:` line, the agent may use `pwd` once to orient.
- Agents performing codebase exploration (planner, learner) are not subject to this rule — they need to discover structure.
