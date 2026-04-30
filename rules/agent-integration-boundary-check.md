---
id: agent-integration-boundary-check
title: Verify Integration Boundaries End-to-End
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - reviewer
  - tester
  - engineer
---

When a feature crosses an integration boundary — the seam between two independently developed components — unit tests on each side are insufficient. The end-to-end path through the boundary must be verified with real inputs in the real runtime environment.

Integration boundaries include: MCP tool calls from an orchestrator, env var dependencies, file system conventions (where another process writes and this process reads), CLI flag contracts, IPC protocols, and any interface where one side is "the caller will do X" and the other side is "we assume the caller did X."

## Rationale

Unit tests mock the boundary by definition. Each side passes in isolation, but the contract between them was never executed. This failure mode is invisible to code review because the code is correct — the bug is that nobody called it, or called it with the wrong inputs, or the runtime doesn't provide what the code expects.

Three rounds of "fixing" Canon's transcript capture feature each added correct, tested code on one side of the boundary (MCP tool, logStep integration, env var lookup) without ever running the actual path: orchestrator spawns agent → agent completes → orchestrator calls log_step with agent_id → logStep calls captureTranscript → captureTranscript finds the source file → transcript written. Every round declared success based on unit tests.

## Signals

A change likely crosses an integration boundary when:

- It reads env vars or config that another process sets
- It reads files that another process writes (or vice versa)
- It implements one side of a tool/API that a different agent or process calls
- It depends on runtime context (session IDs, process state) not available in tests
- Tests mock the other side of the interface

## What to Check

**Engineer**: When your implementation depends on a runtime value or external caller, state in your summary what you verified end-to-end vs. what you could only unit test. "Unit tests pass with mocked env vars" is honest. "Feature works" when you only ran unit tests is not.

**Reviewer**: When the diff includes mocked boundaries (env vars set in beforeEach, fake file paths, stubbed external calls), flag the boundary and ask: was the real path verified? If the engineer summary only mentions unit tests for a feature that crosses an integration boundary, flag it as a WARNING.

**Tester**: When writing tests for boundary-crossing features, include at least one test that exercises the real path — or document why that's not feasible and what is being assumed.

## Exceptions

Pure library code with no external dependencies. Internal refactors that don't change the boundary contract.
