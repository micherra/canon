---
id: agent-informed-questions
title: Questions Must Cite Codebase Evidence
severity: rule
scope:
  agents: [architect]
tags:
  - agent-behavior

  - architect
---

Every question an agent asks the user during an interview or design conversation must cite specific codebase evidence obtained from MCP tools (`get_file_context`, `graph_query`, `semantic_search`). Generic questions that could be asked without reading the codebase are prohibited.

## Rationale

The interview and design conversation phases exist to surface information the agent cannot determine from the codebase alone. If the agent asks a question it could have answered by reading the code, it wastes a HITL round-trip -- the most expensive operation in the pipeline. Every round-trip must justify its cost by asking something only the user can answer, grounded in what the agent already knows from investigation.

Generic questions ("What are your requirements?", "What should the API look like?") signal that the agent has not investigated. They shift the burden of discovery to the user, who should not have to teach the agent what the codebase already reveals.

## Examples

**Bad -- generic question with no codebase evidence:**

```
What error handling approach do you want to use?
```

The agent could discover the project's error handling patterns by reading the codebase. This question reveals zero investigation.

**Good -- question grounded in codebase investigation:**

```
The codebase uses two error handling patterns: Result<T, E> in the 23 service files
under src/services/, and thrown exceptions in the 4 legacy integration wrappers
(payment, email, sms, pdf). Your new service will call both. Should it follow the
Result pattern for its own errors and catch-and-wrap the legacy exceptions, or do you
want to migrate the legacy callers first?
```

The agent investigated, found a tension, and is asking the user to make a judgment call that requires domain knowledge.

**Bad -- question the agent could answer from the codebase:**

```
Which files will this change affect?
```

The agent has `graph_query` and `get_file_context`. It should identify the affected files and ask the user to confirm, not ask the user to do the discovery.

**Good -- confirmation with evidence:**

```
Based on the dependency graph, changing UserService.getProfile() return type affects
14 callers across 3 modules: auth (4 files), dashboard (6 files), and admin (4 files).
The admin module also has 2 API response schemas that serialize the profile. Are you
expecting all 14 callers and 2 schemas to be updated in this build, or should the
change be backward-compatible with a deprecation period?
```

The agent did the discovery and is asking for a scope decision only the user can make.

## Exceptions

None. If you cannot find codebase evidence relevant to a question, either:
1. The question is genuinely about user intent (not the codebase) -- phrase it as such: "This is a product decision I can't determine from the code: [question]"
2. The question is about the codebase but KG/file context is unavailable -- note this: "I wasn't able to verify X in the codebase (KG unavailable). Can you confirm: [question]?"
