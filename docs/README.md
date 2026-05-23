# Canon Documentation

This directory contains human-readable documentation about Canon's architecture, design decisions, and engineering analysis. Everything here is written for human engineers and architects — people who need to understand how Canon works, why it is designed the way it is, and what tradeoffs were made.

## What Lives Here

The `reference/` subdirectory contains authoritative reference documentation. The primary reference — `canon-reference.md` — is the single comprehensive guide covering Canon's MCP tool signatures, flow schema, hook configuration, and principles overview. When you need to know the exact parameters for an MCP tool or the structure of a flow definition, this is where to look.

The root of this directory holds architecture analysis and direction documents. The bounded-context map describes how the MCP server's eight bounded contexts relate to each other. The supervised-build-quality document captures the current direction: what shipped, what's next, and the prioritized feature backlog.

The `images/` subdirectory holds diagrams and screenshots referenced by the documents here.

## What Doesn't Live Here

Docs are for humans. Two other documentation systems serve different audiences:

**CLAUDE.md files** (found at `{dir}/.claude/CLAUDE.md` throughout the codebase) are agent-facing documentation. They describe conventions, contracts, and architecture boundaries that Canon's specialist agents need to work correctly in a given directory. They are optimized for programmatic consumption by agents, not for human readability.

**Code comments and docstrings** explain individual functions and modules. They live in the code they describe, not in this directory.

The distinction matters: if you find yourself writing something that an agent needs to know to do its job correctly, it belongs in a CLAUDE.md file. If you're writing something that a human engineer needs to understand how the system works, it belongs here.

## Keeping Docs Current

The `canon-reference.md` file in `reference/` is the document most likely to drift — it documents MCP tool signatures that change when the server is updated. Update it when tools are added, removed, or have their parameters changed.

Direction documents like `supervised-build-quality.md` should be updated when priorities shift or epics ship. The bounded-context map should be updated when new bounded contexts are added or existing ones are restructured.
