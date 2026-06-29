---
name: team-dispatch-protocol
description: >-
  Full three-phase team dispatch protocol for Canon review fan-out. Covers
  Phase 1 (partition by blast radius), Phase 2 (spawn N reviewers in parallel),
  and Phase 3 (consolidate with minority-finding verification probes).
---

# Team Dispatch Protocol

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Full partition → spawn → consolidate protocol for team-dispatched reviews. Read BEFORE spawning a team-dispatched review step. See `CLAUDE.md` § Team Dispatch Protocol for the fan-out threshold and inline one-liner.

#### Phase 1 — Partition

Before spawning a team-dispatched review step, call `get_file_context` for each changed file and examine blast radius data (`in_degree`, `impact_score`, `blast_radius`). The fan-out decision is based on **aggregate blast radius** — NOT a fixed file count threshold. Signals that warrant fan-out:

- Total blast radius entries across all changed files exceeds ~50 (many downstream dependents affected)
- Multiple changed files have `impact_score > 0.7` (high-centrality changes)
- Changed files span 3+ layers with cross-layer dependencies

When fan-out is warranted, partition files into N groups (typically 2–3). Partitioning rules:

- Files in the same dependency cycle stay together
- High `in_degree` files get smaller groups (more attention per reviewer)
- Files in the same directory/module stay together when possible
- Co-change partners (from `co_change_partners`) stay together

When fan-out is NOT warranted, spawn a single reviewer with the full file list (standard single-subagent pattern).

#### Phase 2 — Spawn

Spawn N reviewers in parallel via `Agent()`, each with:

- The standard preloaded context from `resolve_agent_skills`
- `WORKSPACE={workspace_path}` (workspace root, not worktree)
- An explicit diff base: "Diff against commit {base_commit}: use `git diff {base_commit}..HEAD` instead of `git diff main..HEAD`"
- Their assigned file list
- Their reviewer number: "You are reviewer {N} of {total}. Write your review to `${WORKSPACE}/reviews/REVIEW-{N}.md`."
- No `isolation` parameter (reviewers run in the shared workspace, not a worktree)

#### Phase 3 — Consolidate

After all reviewers complete, read all `REVIEW-{N}.md` files and consolidate into the final `REVIEW.md`:

1. **Deduplicate**: Group violations by `(file_path, principle_id, line_number)`. Violations found by 2+ reviewers are confirmed — include them directly.
2. **Identify minority findings**: Violations found by only 1 of N reviewers are minority findings. These are NOT dismissed — they get a verification probe.
3. **Verification probe for minority findings**: For each minority finding:
   a. Spawn a focused verification reviewer (a single `canon:reviewer` subagent) with ONLY the specific file and the minority finding's description: "Verify whether the following finding is a true positive: {violation description} at {file:line}. Grep for the pattern and report CONFIRMED or DISMISSED with evidence."
   b. If CONFIRMED: promote to the consolidated `REVIEW.md` as a verified finding. Tag as `[minority-verified]`.
   c. If DISMISSED: log in the consolidated `REVIEW.md` under a `### Dismissed Minority Findings` section with the dismissal reason. Do NOT silently drop.
   d. **Scope limit**: If more than 5 minority findings exist, prioritize by severity (BLOCKING > WARNING) and blast radius. Probe the top 5; log the remainder as `[minority-unverified]` in the dismissed section.
4. **Union**: Merge honored lists from all reviewers.
5. **Score**: Sum scores across reviewers, adjusting for deduplicated violations.
6. **Verdict**: Take worst-case verdict across all reviewers (BLOCKING > WARNING > CLEAN). Minority-verified findings count toward the verdict.
7. Write using the `write_review` MCP tool.
