# Canon Documentation

This directory contains human-readable documentation about Canon's architecture, design decisions, and engineering analysis. Everything here is written for human engineers and architects — people who need to understand how Canon works, why it is designed the way it is, and what tradeoffs were made.

## What Lives Here

The `reference/` subdirectory contains authoritative reference documentation. The primary reference — `canon-reference.md` — is the single comprehensive guide covering Canon's MCP tool signatures, flow schema, hook configuration, and principles overview. When you need to know the exact parameters for an MCP tool or the structure of a flow definition, this is where to look.

The root of this directory holds architecture analysis, roadmaps, and retrospectives. These documents capture point-in-time thinking that may still be useful even after its immediate recommendations are implemented. The bounded-context map describes how the MCP server's eight bounded contexts relate to each other. The codebase intelligence roadmap captures the direction of Canon's knowledge graph and semantic search capabilities. Historical retrospectives preserve the lessons from past design experiments.

The `images/` subdirectory holds diagrams and screenshots referenced by the documents here.

## What Doesn't Live Here

Docs are for humans. Two other documentation systems serve different audiences:

**CLAUDE.md files** (found at `{dir}/.claude/CLAUDE.md` throughout the codebase) are agent-facing documentation. They describe conventions, contracts, and architecture boundaries that Canon's specialist agents need to work correctly in a given directory. They are optimized for programmatic consumption by agents, not for human readability.

**Code comments and docstrings** explain individual functions and modules. They live in the code they describe, not in this directory.

The distinction matters: if you find yourself writing something that an agent needs to know to do its job correctly, it belongs in a CLAUDE.md file. If you're writing something that a human engineer needs to understand how the system works, it belongs here.

## Keeping Docs Current

The `canon-reference.md` file in `reference/` is the document most likely to drift — it documents MCP tool signatures that change when the server is updated. Update it when tools are added, removed, or have their parameters changed.

Architecture analysis and retrospective documents are less sensitive to drift. Their value is often in capturing the reasoning at a moment in time, even if the system has moved on. Resist the urge to delete them just because their recommendations have been implemented — the reasoning is still useful context.
