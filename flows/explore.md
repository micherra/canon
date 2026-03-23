---
name: explore
description: Research and report on a codebase question — no implementation

states:
  research:
    type: parallel
    agents: [canon-researcher]
    roles: [codebase, dependencies]
    template: research-finding
    transitions:
      done: synthesize
      blocked: hitl

  synthesize:
    type: single
    agent: canon-architect
    role: analysis
    inject_context:
      - from: research
        as: research_findings
    transitions:
      done: done
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### research
Research ${role} aspects of: ${task}. Be thorough — read source files, trace call paths, check configurations, examine test coverage. Save to ${WORKSPACE}/research/${role}.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

For codebase role: focus on how the system works today — architecture, data flow, key abstractions, entry points.
For dependencies role: focus on external dependencies, integration points, configuration, and constraints.

### synthesize
Synthesize research findings into an actionable analysis. Read all research from ${WORKSPACE}/research/. Produce a clear report answering: ${task}. Include architecture diagrams (text), key findings, risks, and recommended next steps. Save to ${WORKSPACE}/plans/${slug}/ANALYSIS.md.
