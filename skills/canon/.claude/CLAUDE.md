# Canon Skill — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Claude Code skill definition that activates Canon when installed. This directory is the entry point Claude Code reads to load Canon's orchestrator identity, slash commands, and reference fragments.

## Architecture
<!-- last-updated: 2026-04-09 -->

- `SKILL.md` — Entry point read by Claude Code on activation; sets the orchestrator persona and links to references
- `commands/` — Slash command definitions (e.g., `/canon:init`, `/canon:check`, `/canon:doctor`); each command is a markdown file with a YAML frontmatter describing the command's behavior
- `evals/` — Evaluation suite for testing Canon's intent classification and flow routing; contains `eval-set.json`, fixture data, and `run-evals.sh`
- `references/` — Reference fragments injected into agent context at runtime; covers orchestrator protocol, principle loading, workspace logging, status protocol, and other cross-cutting concerns

## Routing Contract
<!-- last-updated: 2026-05-15 -->

SKILL.md intent routing (authoritative; aligned to root CLAUDE.md as of 2026-05-15):

| Intent | Action |
|--------|--------|
| Build, fix, change, improve | Spawn `planner` |
| Review PR or branch | Spawn `reviewer` |
| Security audit | Spawn `security`, then `reviewer` |
| Investigate / "how does X work" | Spawn `planner` |
| Create/edit principle | Spawn `canon:writer` |
| Analyze patterns / learn | Spawn `canon:learner` |
| Question | Respond directly |
| Chat / brainstorm | Respond directly |
| Resume | Read journal → resume |
| Greeting | Respond directly |

**Removed agents (no longer referenced in SKILL.md):** `canon:chat`, `canon:guide`, `canon:fixer`. **Removed escape hatch:** "Inline Mode" (Principle Loading outside a pipeline) was deleted.

## Conventions
<!-- last-updated: 2026-04-09 -->

- `SKILL.md` is read by Claude Code on activation and must remain the authoritative entry point
- Slash commands in `commands/` are user-facing; keep descriptions concise and action-oriented
- Reference fragments in `references/` are loaded by agents on demand — they are not injected wholesale; agents load only what their role requires
- Evals in `evals/` are run via `run-evals.sh` to validate orchestrator behavior after changes to flow definitions or agent instructions
