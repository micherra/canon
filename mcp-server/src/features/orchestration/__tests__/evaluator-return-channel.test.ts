/**
 * evaluator-return-channel — dc-05 regression guard (ADR-0061).
 *
 * The evaluator gate never delivered a verdict: canon:evaluator was spawned as a
 * NAMED (teammate) agent, but its tool grant (`tools: [Read]`) has no SendMessage
 * and no write tool — a named spawn returns output only via mailbox, and the
 * evaluator has no mailbox. See
 * docs/adr/0061-evaluator-verdict-returns-by-tool-result-not-mailbox.md
 * (ADR-0061) for the root-cause probe.
 *
 * This test encodes the general invariant behind the fix, not just the literal
 * fix: an agent whose `tools:` grant confers no write capability (Write/Edit/
 * write_*) AND no SendMessage has no way to return output from a named spawn,
 * and must therefore never be mandated a named spawn in CLAUDE.md's
 * evaluator-gate step 3.
 *
 * MUST live under mcp-server/src/ so `npm test` (working-directory: mcp-server)
 * picks it up — a repo-root __tests__/ placement would be orphaned and never run
 * in CI. Follows the precedent shape of
 * ../../loops/__tests__/command-registration.test.ts (marker-walk to repo root
 * via .claude-plugin/plugin.json).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Resolve the repo root by walking up from this file's directory until we find
 * .claude-plugin/plugin.json — a unique repo-root marker. We assert its presence
 * rather than hardcoding a depth, so a directory restructure fails loudly here
 * instead of silently using the wrong root.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  throw new Error(
    `Could not locate repo root from ${startDir}: ` +
      ".claude-plugin/plugin.json not found within 10 ancestor levels. " +
      "If the test file was moved, update the marker-walk depth or anchor.",
  );
}

type AgentFrontmatter = {
  name: string | null;
  tools: string[];
};

/** Minimal frontmatter parse — just the two fields this guard needs. */
function parseAgentFrontmatter(raw: string): AgentFrontmatter {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { name: null, tools: [] };
  const fm = fmMatch[1];

  const nameMatch = fm.match(/^name:\s*(\S+)\s*$/m);
  const name = nameMatch ? nameMatch[1] : null;

  const toolsBlockMatch = fm.match(/^tools:\n((?:[ \t]*-[ \t].+\n?)+)/m);
  const tools = toolsBlockMatch
    ? toolsBlockMatch[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim())
    : [];

  return { name, tools };
}

/**
 * An agent can return output from a NAMED (teammate) spawn only via SendMessage,
 * or durably via a write capability (Write/Edit/any write_* or
 * mcp__canon__write_* tool) that a peer or the orchestrator can later read.
 */
function hasReturnChannel(tools: string[]): boolean {
  return tools.some(
    (tool) =>
      tool === "SendMessage" || tool === "Write" || tool === "Edit" || tool.includes("write_"),
  );
}

describe("zero-return-channel agent set (dc-05, ADR-0061)", () => {
  const repoRoot = findRepoRoot(import.meta.dirname);

  it("is exactly ['evaluator']", () => {
    const agentsDir = join(repoRoot, "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md") && f !== "README.md");

    const zeroChannel: string[] = [];
    for (const file of files) {
      const raw = readFileSync(join(agentsDir, file), "utf-8");
      const { name, tools } = parseAgentFrontmatter(raw);
      if (!name) continue; // not a real agent-def file
      if (!hasReturnChannel(tools)) {
        zeroChannel.push(name);
      }
    }

    expect(
      zeroChannel,
      "The zero-return-channel agent set changed. If a NEW agent has no SendMessage and no " +
        "write capability, it must never be spawned named (see ADR-0061) — CLAUDE.md's spawn " +
        "config for it needs the same unnamed+synchronous treatment as the evaluator. If " +
        "'evaluator' gained a channel, ADR-0061's constraint has dissolved (see its " +
        "Revisit-If section) and this expectation should be updated deliberately, not silenced.",
    ).toEqual(["evaluator"]);
  });
});

/**
 * Slices CLAUDE.md to just the evaluator-gate Post-Step Effects bullet, so
 * unrelated CLAUDE.md edits elsewhere in the file cannot false-positive these
 * assertions.
 */
function extractEvaluatorGateBlock(claudeMd: string): string {
  const anchor = "evaluator gate (post-step effect";
  const anchorIdx = claudeMd.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(
      "Could not locate the evaluator-gate block anchor text " +
        `("${anchor}") in CLAUDE.md — the heading/prose may have moved. ` +
        "Update this test's anchor to match.",
    );
  }
  const blockStart = claudeMd.lastIndexOf("\n- ", anchorIdx);
  if (blockStart === -1) {
    throw new Error(
      "Could not find the start of the evaluator-gate bullet (no preceding '\\n- ').",
    );
  }

  const endMarker = "- **After architect**";
  const endIdx = claudeMd.indexOf(endMarker, anchorIdx);
  if (endIdx === -1) {
    throw new Error(
      `Could not locate the "${endMarker}" bullet after the evaluator-gate block — ` +
        "the Post-Step Effects section may have been reordered. Update this test's anchor.",
    );
  }

  return claudeMd.slice(blockStart, endIdx);
}

describe("CLAUDE.md evaluator-gate block invariants (ADR-0061)", () => {
  const repoRoot = findRepoRoot(import.meta.dirname);
  const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8");
  const block = extractEvaluatorGateBlock(claudeMd);

  it("dc-01: mandates an unnamed, synchronous evaluator spawn", () => {
    expect(
      block,
      "Step 3 must specify run_in_background: false so the evaluator's final message returns " +
        "as the Agent tool result rather than requiring a SendMessage mailbox delivery it has " +
        "no tool to perform (ADR-0061).",
    ).toMatch(/run_in_background:\s*false/);

    // Format-agnostic: reject ANY name: directive for the evaluator spawn, regardless of
    // quoting style or the specific name string chosen. A literal-string check here (e.g.
    // .not.toMatch(/name:\s*["'`]?evaluator-eval/)) has a hole: a future contributor could
    // "tidy" the spawn back to a named form using a DIFFERENT name (e.g. `name: eval-gate-x`)
    // and this guard would stay silent while structurally reviving the exact mailbox-only
    // silent-verdict-loss bug ADR-0061 fixes. Match any `name:` token followed by an
    // identifier-shaped value (bare or quoted) — that's a directive, not prose. The adjacent
    // "Do not pass `name:`." instruction sentence does NOT match: nothing identifier-shaped
    // follows "name:" there — just a closing backtick then a period.
    expect(
      block,
      "Step 3 must NOT mandate a name: directive (in ANY format — bare, quoted, or " +
        "backticked) for the evaluator spawn. canon:evaluator has no SendMessage and no " +
        "write tool, so a named (teammate) spawn has no channel to return its verdict — " +
        "this is the root cause ADR-0061 fixes. If you are re-adding a name: here under any " +
        "spelling, read ADR-0061 first; this is exactly the 'tidying' regression it warns " +
        "about, and a literal-string check would not have caught it.",
    ).not.toMatch(/name:\s*["'`]?[A-Za-z0-9_-]+/);

    expect(
      block,
      "Step 3 must retain the explicit 'Do not pass name:' instruction — silently dropping " +
        "the directive without its accompanying prose warning would regress the next time " +
        "someone edits this block without reading ADR-0061 first.",
    ).toMatch(/Do not pass `name:`/);
  });

  it("dc-03: step 7 keeps the fail-open PASS_parse_fallback mapping", () => {
    expect(
      block,
      "Step 7 must still map a parse failure to PASS_parse_fallback and proceed. Converting " +
        "this to a blocking/fail-closed branch would violate the deliberate fail-open posture " +
        "of this advisory quality gate (ADR-0061 Consequences; fail-closed-by-default governs " +
        "*safety* gates only).",
    ).toMatch(/PASS_parse_fallback/);
  });

  it("dc-04: all three non-evaluation branches are named and surfacing is mandated", () => {
    expect(block, "step 2's tool_unavailable skip branch must still be present").toMatch(
      /tool_unavailable/,
    );
    expect(block, "step 2's tool_error skip branch must still be present").toMatch(/tool_error/);
    expect(block, "step 7's PASS_parse_fallback branch must still be present").toMatch(
      /PASS_parse_fallback/,
    );
    // Deliberately more specific than a bare /surface/i — the block already contains an
    // unrelated "surface via the gate-failure HITL pattern" phrase in the FAIL branch (step 6),
    // which would make a loose match pass even before this build's edit. Require the phrase to
    // name what's being surfaced (an advisory), not just any use of the word "surface".
    expect(
      block,
      "The evaluator-gate block must mandate surfacing a one-line advisory when a " +
        "non-evaluation branch fires — a prose instruction to shout that itself goes " +
        "unenforced is exactly the disease this bug exhibited (see ADR-0061).",
    ).toMatch(/surface[^.]*advisory/i);
  });
});
