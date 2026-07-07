/**
 * agent-tool-wiring — parity guard for the write-receipt gate's three new
 * dedicated write tools (wrgate-04, ADR-0042). Each of architect/scribe/
 * security must BOTH grant its new tool in frontmatter AND call it in the
 * agent body — a grant without a body call is a dead grant that would
 * produce an un-receipted artifact (WR-02 weak-pass every time).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Tests run with mcp-server/ as cwd — repo root is one level up (same
// convention as resolve-agent-skills-integration.test.ts).
const REPO_ROOT = resolve(process.cwd(), "..");

type WiringCase = {
  agentFile: string;
  grantToken: string;
  callToken: string;
};

const CASES: WiringCase[] = [
  {
    agentFile: "agents/architect.md",
    callToken: "write_design(",
    grantToken: "mcp__canon__write_design",
  },
  {
    agentFile: "agents/scribe.md",
    callToken: "write_context_sync(",
    grantToken: "mcp__canon__write_context_sync",
  },
  {
    agentFile: "agents/security.md",
    callToken: "write_security_assessment(",
    grantToken: "mcp__canon__write_security_assessment",
  },
];

describe("wrgate-04 — agent grant + body-call parity", () => {
  for (const { agentFile, grantToken, callToken } of CASES) {
    it(`${agentFile} grants ${grantToken} AND calls ${callToken}`, async () => {
      const content = await readFile(join(REPO_ROOT, agentFile), "utf-8");
      expect(content.includes(grantToken), `${agentFile} missing frontmatter grant`).toBe(true);
      expect(content.includes(callToken), `${agentFile} missing body call`).toBe(true);
    });
  }

  it("security.md no longer grants the bare Write tool (its only artifact is now receipt-backed)", async () => {
    const content = await readFile(join(REPO_ROOT, "agents", "security.md"), "utf-8");
    const frontmatterEnd = content.indexOf("\n---", content.indexOf("---") + 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(/^\s*- Write\s*$/m.test(frontmatter)).toBe(false);
  });
});
