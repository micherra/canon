---
id: content-addressed-resolver-fail-loud
title: Resolvers Are Content-Addressed and Fail Loud
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "**/*.ts"
    - "**/*.js"
    - "**/*.sh"
    - "**/*.mjs"
tags:
  - resilience
  - resolvers
  - testing
  - lessons-learned
---

Resolver or locator logic that discovers a resource at runtime (a config file, a plugin root, an install directory) must be **content-addressed**: it probes whether the candidate target actually exists (`[ -f "$cand/boot.sh" ]`, `fs.existsSync(...)`) rather than **name-addressed**: trusting that an env var or pointer names the right location. No single variable is load-bearing for correctness. The resolver must have a **fail-loud terminal**: when no candidate passes all probes, it emits an actionable error and exits non-zero — never a silent degraded fallback.

## Rationale

A name-addressed resolver treats "the env var is set" as proof of correctness. It is not — the var can point at a stale, half-installed, or wrong-version location, and the resolver has no way to notice because it never checks the target itself. The failure surfaces later, indirectly, as a downstream error that looks unrelated to the resolver.

This pattern recurred as the same defect class five separate times in one codebase's boot resolver (five fix attempts across five PRs) before it was durably closed. Every prior fix added or reordered name-based checks — a new env var, a different fallback order — and the bug returned in a new shape each time, because the resolver still never verified the thing it resolved to. The fix that ended the recurrence replaced name-based trust with content probes plus a loud terminal failure: one structural change closed a defect class that four prior patches had failed to close.

## Examples

**Bad — name-addressed, trusts the pointer, silent fallback:**

```bash
# Trusts CANON_PLUGIN_DIR is correct without checking its contents
if [ -n "$CANON_PLUGIN_DIR" ]; then
  SERVER_DIR="$CANON_PLUGIN_DIR/mcp-server"
else
  SERVER_DIR="$HOME/.claude/plugins/canon/mcp-server"  # silent guess
fi
# No check that boot.sh actually exists at SERVER_DIR — failure surfaces later, indirectly
```

**Good — content-addressed, probes existence, fails loud on exhaustion:**

```bash
for cand in "$CANON_PLUGIN_DIR" "$HOME/.claude/plugins/canon" "$SCRIPT_DIR/.."; do
  [ -z "$cand" ] && continue
  if [ -f "$cand/mcp-server/boot.sh" ]; then
    SERVER_DIR="$cand/mcp-server"
    break
  fi
done
if [ -z "$SERVER_DIR" ]; then
  echo "CANON FATAL: no candidate directory contains mcp-server/boot.sh. Checked: ..." >&2
  exit 1
fi
```

## Companion test rule

Regression tests for a shipped config, payload, or template MUST extract the value under test from the REAL shipped artifact (not a hardcoded fixture copy), so the test and the shipped artifact cannot drift independently. A test that asserts against a hardcoded string can stay green forever while the shipped artifact silently breaks — this is exactly how a resolver defect can survive multiple release cycles undetected by CI: the test kept passing on the old shape while the shipped config drifted underneath it.

```typescript
// Bad — hardcoded copy can drift from the real shipped config
expect(tokenPath).toBe("~/.claude/canon/canon-mcp-token");

// Good — reads the real shipped artifact
const shipped = JSON.parse(readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8"));
expect(tokenPath).toBe(shipped.mcpServers.canon.env.CANON_MCP_TOKEN_FILE);
```

## Exceptions

Resolvers over resources that are guaranteed present by the platform itself (e.g., `process.cwd()`) do not need a fail-loud terminal — there is no candidate list to exhaust. Purely in-memory lookups with a single, statically-known source have no name-vs-content distinction to make.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The env var is always set correctly in our deploy." | "Always" is exactly the assumption that failed five times in the same codebase — deploys drift, get half-applied, or point at stale installs. | Probe the candidate's contents before trusting it, regardless of how reliable the setter is believed to be. |
| "A silent fallback is friendlier than crashing." | A silent fallback to a wrong location produces a confusing downstream error far from the resolver, costing far more debugging time than a loud, actionable failure at the source. | Fail loud with the exact candidates checked and why each was rejected. |
| "This test already checks the config shape." | A test against a hardcoded copy of the config shape passes even after the real shipped config diverges from it. | Read the real shipped artifact in the test, not a copy. |

## Verification

- [ ] Any new resolver/locator probes candidate existence (content-addressed) rather than trusting an env var or pointer alone.
- [ ] The resolver has a fail-loud terminal: an actionable error message and non-zero exit when no candidate passes.
- [ ] Any new regression test for a shipped config/payload/template reads the real shipped artifact, not a hardcoded copy.

## Related

[[design-for-self-healing]] — a fail-loud resolver surfaces the failure so a human or supervisor can recover, rather than degrading silently. [[infrastructure-tested-like-code]] — the companion test rule is a specific instance of validating infrastructure/config definitions before they're trusted. [[test-data-belongs-in-the-test]] — distinct concern: that principle is about test-data locality (fixtures live with the test), while the companion rule here is about shipped-artifact drift-prevention (the test must read the real artifact, not a copy) — the two do not overlap in scope.
