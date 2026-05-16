---
id: agent-worktree-orientation
title: Verify Worktree and Branch at Spawn Start
severity: rule
tags: [agent-behavior, worktree, git]
---

When your spawn prompt includes a `Working directory: {path}` or `worktree_path`, you MUST verify your environment before starting work.

## Rule

At spawn start, before reading any files or writing any code:

1. **Verify working directory**: Run `pwd` and confirm it matches the declared working directory. If using Bash, all commands must use absolute paths rooted at the worktree path.
2. **Verify branch**: Run `git branch --show-current` in the worktree directory and confirm the branch matches the expected pattern (`canon/{slug}` or `canon-task/{task_id}`).
3. **If either check fails**: Report `BLOCKED` with detail: "Worktree mismatch: expected {expected}, got {actual}". Do not proceed with work.
4. **Use absolute paths** for ALL file operations. Never rely on `cwd` implicitly — always specify the full path rooted at the worktree path provided in your spawn prompt.

## Rationale

NF-15 showed that an engineer committed directly to `main` instead of the `canon/{slug}` branch. Without explicit branch verification, agents that operate in worktrees can silently pollute the wrong branch.

Canon manages worktree lifecycle via `init_workspace`, which creates the worktree at `{workspace}/worktree` on a `canon/{slug}` branch. The orchestrator passes this path as `worktree_path` in your spawn prompt. If your execution context does not match this path and branch, your commits will land in the wrong place.

Absolute-path discipline is the companion to branch verification: an agent that uses relative paths may write files to an unexpected location when its `cwd` is not what it expects.

## Examples

**Bad — agent runs git commit without checking branch, ends up on main:**

```
Agent spawned with: "Working directory: /workspace/my-flow/worktree"

[agent reads files using relative paths]
[agent writes code]
git commit -m "feat: implement feature"  # commits to whatever branch cwd is on
```

If the agent's cwd is the project root (main branch) rather than the worktree, the commit lands on main and bypasses the build branch entirely.

**Good — agent verifies branch before starting work:**

```
Agent spawned with: "Working directory: /workspace/my-flow/worktree"

# Step 1: orient
cd /workspace/my-flow/worktree  # or use absolute paths from the start
git branch --show-current
# → "canon/my-feature-slug"  ✓ matches expected pattern

# Step 2: all file operations use absolute paths
[Write /workspace/my-flow/worktree/src/feature.ts]

# Step 3: commit from the correct directory
git -C /workspace/my-flow/worktree commit -m "feat: implement feature"
```

## Exceptions

- **Agents without `worktree_path`**: Agents spawned without a `Working directory` or `worktree_path` in their spawn prompt are exempt — they have no declared worktree to verify against.
- **`.canon/`-only agents**: Agents that write exclusively to `.canon/` (gitignored) are exempt from branch verification, since their writes are branch-independent and cannot pollute a build branch. Currently: learner.
