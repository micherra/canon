---
id: no-llm-calls-in-mcp-tools
title: MCP Tools Must Not Make LLM API Calls
severity: rule
portable: false
scope:
  layers:
    - shared
  file_patterns:
    - "mcp-server/**"
tags:
  - agent-behavior
  - mcp-server
  - principles
---

Canon's MCP tools must not import or invoke external LLM APIs — Anthropic SDK, OpenAI SDK, or any equivalent — for reranking, filtering, scoring, or re-evaluating content. Principle selection, candidate filtering, and relevance judgments are structural operations (tag intersection, layer matching, file-pattern scope) performed by the tool. If an agent receiving tool output needs to reason about relevance, the agent performs that reasoning. The tool returns candidates; the agent decides.

## Rationale

Canon's MCP tools are called by Claude Code agents. The agent is already an LLM. Adding an LLM call inside the tool that serves the agent creates a circular dependency: the tool calls the very consumer it was designed to serve. This pattern is architecturally unsound for three reasons.

**Circular dependency.** The MCP server is a tool layer, not an intelligence layer. When `get_principles` calls Claude Sonnet to rerank results before returning them to a Claude Sonnet agent, the tool is delegating reasoning to its own caller via a separate SDK session. The agent cannot see this delegation, cannot audit it, and cannot correct it. Reasoning that belongs in the agent has been moved invisibly into the tool.

**Cost and fragility.** Every tool call that triggers a hidden LLM call multiplies token cost. It also introduces a required environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) that the MCP server has no other reason to hold. The server becomes deployment-fragile: it fails silently or noisily depending on key availability, key permissions, and rate limits that the calling agent cannot observe.

**Violation of the no-external-API design constraint.** The MCP server's approved design explicitly states that all computation is local. Structural matching — tag intersection, layer filtering, scope matching, semantic vector search over pre-computed embeddings — is local computation. Calling a remote LLM model is not. Introducing any external API call for content reasoning violates this constraint regardless of the quality of results it produces.

The tag-based matching system (community detection, tag propagation, scope intersection) narrows principles to a relevant subset. That subset is the correct output of the tool. An agent that needs further prioritization reads the candidates and applies its own reasoning — which is exactly what agents are built to do.

## Examples

**Bad — LLM reranker embedded in `get_principles`:**

```typescript
import Anthropic from "@anthropic-ai/sdk";

// Inside get_principles tool handler
async function rerank(candidates: Principle[], query: string): Promise<Principle[]> {
  const client = new Anthropic();  // requires ANTHROPIC_API_KEY in MCP server env
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: `Select the top 5 most relevant principles for: "${query}"\n\n${JSON.stringify(candidates)}`,
    }],
  });
  // parse response, return subset...
}
```

This makes `get_principles` non-deterministic, token-expensive, and dependent on an external credential. The calling agent never knows a second LLM judgment was made on its behalf.

**Good — structural filtering only; agent handles relevance:**

```typescript
// Inside get_principles tool handler — local computation only
function filterPrinciples(
  all: Principle[],
  { layers, tags, filePaths }: GetPrinciplesArgs,
): Principle[] {
  return all.filter((p) =>
    matchesLayers(p, layers) &&
    matchesTags(p, tags) &&
    matchesFilePatterns(p, filePaths),
  );
}

// The tool returns all structural matches.
// The agent receiving this list reasons about relevance — no hidden API call.
```

**Bad — scoring via OpenAI embeddings with a remote API call:**

```typescript
import OpenAI from "openai";

async function scoreRelevance(principle: Principle, context: string): Promise<number> {
  const openai = new OpenAI();  // remote API — not local computation
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: context });
  // compute cosine similarity...
}
```

**Good — local vector similarity over pre-computed embeddings:**

```typescript
// Pre-computed embeddings stored at index time, not fetched at query time.
// Cosine similarity is pure math — no external API call.
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

## Exceptions

Local vector operations over pre-computed embeddings are permitted. Generating or querying embeddings using a **local model** (e.g., a bundled ONNX model or a local inference server with no external network dependency) is also permitted. The constraint is on external network calls to remote LLM APIs for reasoning or reranking — not on local mathematical computation over vectors.

If Canon ever adds a feature that requires remote API calls for reasoning (e.g., a dedicated explanation service), that feature must live outside the MCP tool pipeline and must be opt-in with explicit user consent and visible cost.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The reranker improves result quality — agents get better principles." | The calling agent can apply the same reasoning over the candidates itself. Hiding that reasoning inside the tool removes the agent's ability to audit, override, or explain the selection. Return all structural matches and let the agent reason. |  Remove the reranker. Return the full structurally-matched candidate set. |
| "It's just one extra API call — the overhead is negligible." | Every `get_principles` invocation in a build flow may be called 10–20 times. A hidden API call per invocation multiplies cost by 10–20x for a capability the calling agent already has. | Local computation only. If latency or token count is a concern, tune the structural matcher. |
| "The reranker uses a small/cheap model — cost is low." | Cost is not the only constraint. The MCP server must not hold an `ANTHROPIC_API_KEY`. A key in the server's environment is a credential management burden and a potential secret-leakage vector. | Remove the dependency on any external API key inside the MCP server. |
| "Embedding generation is the same as calling an LLM." | Embedding generation is a local vector operation when using pre-computed or locally-served models. It produces a numeric representation, not a judgment. The constraint is on reasoning and reranking calls to remote APIs. | Pre-compute embeddings at index time. Query-time similarity is cosine math — permitted. |
| "The tag system doesn't capture all relevance signals." | Structural matching is the correct tool for structural decisions. If the tag system has gaps, fix the tags or expand the structural matching rules. Do not compensate for a gap in one system by importing a different system that operates outside the observable tool contract. | Improve tag coverage, scope rules, or community detection. Keep all selection logic structural and local. |

## Verification

- [ ] No `import` of `@anthropic-ai/sdk`, `openai`, `@azure/openai`, or equivalent LLM SDK packages anywhere under `mcp-server/` — run `grep -r "anthropic-ai/sdk\|from 'openai'\|from \"openai\"" mcp-server/src` and confirm zero results.
- [ ] No `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or equivalent credential is read or required by any MCP tool handler — grep `mcp-server/src` for these env var names and confirm absence.
- [ ] No `messages.create`, `chat.completions.create`, or equivalent LLM generation call appears in any file under `mcp-server/src/features/` — grep for `messages.create\|completions.create\|generateText\|streamText` and confirm zero hits outside test fixtures.
- [ ] Any vector similarity code operates on pre-computed embeddings loaded from disk or a local index — confirm no HTTP or network call is made inside the similarity computation path.
