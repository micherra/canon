/**
 * Codex P1 hardening tests for checkReadOnlyShell.
 *
 * Verifies that the metacharacter-rejection and gh-api-write-flag-rejection
 * checks close the determinism holes identified in Codex P1 on PR #362.
 *
 * Split from loop-schema.test.ts to keep both files under the 600-line limit.
 */
import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// Minimal valid interval frontmatter reused across all cases.
// Bash + shell_commands is the carve-out path being tested.
const baseFrontmatter = {
  id: "_probe",
  title: "Loop Framework Probe",
  status: "active",
  trigger: {
    fired_by: "orchestrator",
    lifecycle_hook: "post-ship",
    firing_posture: {
      autonomous: "disabled",
      "light-touch": "disabled",
      supervised: "opt-in",
    },
  },
  mode: "interval",
  schedule: {
    interval: "1m",
    max_ticks: 3,
  },
  state: {
    scope: "workspace",
    path: "${WORKSPACE}/_probe-state.json",
    snapshot: ["tick_count"],
  },
  observe: {
    tools: [],
    mcp: [],
  },
  surface: {
    on_transition: [
      {
        field: "tick_count",
        to: "3",
        message: "Probe tick 3 reached — framework path proven.",
        terminate: true,
      },
    ],
  },
  terminate: {
    when: ["max_ticks_reached"],
  },
  guardrails: {
    mutates_build: false,
    forbidden_tools: [],
  },
};

/** Build a test frontmatter with Bash carve-out and the given shell_commands list. */
function withShellCommands(cmds: string[]) {
  return {
    ...baseFrontmatter,
    observe: { tools: ["Bash"], mcp: [], shell_commands: cmds },
    guardrails: { mutates_build: false, forbidden_tools: [] },
  };
}

describe("parseLoopDefinition — Codex P1 read-only shell hardening", () => {
  // ── Shell metacharacter rejection ──────────────────────────────────────────

  it("NEG metachar semicolon: 'git log --oneline; git push' → rejected", () => {
    // Semicolon allows a mutating command to ride along on a read-only prefix
    const result = parseLoopDefinition(withShellCommands(["git log --oneline; git push"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG && chain: 'gh pr view 1 && gh pr merge 1' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh pr view 1 && gh pr merge 1"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG redirection: 'git log > /tmp/x' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["git log > /tmp/x"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG command substitution: 'gh api $(echo repos)' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api $(echo repos)"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG pipe: 'git log | head -1' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["git log | head -1"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG backtick substitution: 'gh api `echo repos`' → rejected", () => {
    // backtick is a legacy command substitution form
    const result = parseLoopDefinition(withShellCommands(["gh api `echo repos`"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  it("NEG dollar sign: 'gh api $ENDPOINT' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api $ENDPOINT"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/metacharacter|shell/i);
    }
  });

  // ── gh api write-field flag rejection ────────────────────────────────────────

  it("NEG gh api -f write field: 'gh api repos/x/comments -f body=x' → rejected", () => {
    // -f flag flips gh api from GET to POST
    const result = parseLoopDefinition(
      withShellCommands(["gh api repos/x/comments -f body=x"]),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api -X POST: 'gh api repos/x -X POST' → rejected", () => {
    // -X POST explicitly requests a non-GET method
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -X POST"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api --field: 'gh api repos/x --field key=val' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --field key=val"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api --method DELETE: 'gh api repos/x --method DELETE' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --method DELETE"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api --raw-field: 'gh api repos/x --raw-field q=val' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --raw-field q=val"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api --input: 'gh api repos/x --input file.json' → rejected", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --input file.json"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  // ── Positive cases — must remain admitted ─────────────────────────────────────

  it("POS ship-watch bare prefixes: all 5 declared entries pass", () => {
    // ship-watch.md's observe.shell_commands uses bare prefixes — all must load
    const cmds = ["gh pr view", "gh pr checks", "gh release list", "gh api", "gh repo view"];
    const result = parseLoopDefinition(withShellCommands(cmds), {});
    expect(result.ok).toBe(true);
  });

  it("POS gh api with --jq GET filter: 'gh api repos/x/pulls/1/comments --jq [.[].id]' → ok", () => {
    // brackets and dots are NOT shell metacharacters — must pass
    const result = parseLoopDefinition(
      withShellCommands(["gh api repos/x/pulls/1/comments --jq [.[].id]"]),
      {},
    );
    expect(result.ok).toBe(true);
  });

  it("POS gh api GET read-only query: 'gh api repos/x/pulls/1/comments --jq .[.id]' → ok", () => {
    // GET with --jq is a read-only query — no metachars in this form, no write-field flags
    const result = parseLoopDefinition(
      withShellCommands(["gh api repos/x/pulls/1/comments --jq .[.id]"]),
      {},
    );
    expect(result.ok).toBe(true);
  });

  it("POS gh api -X GET: explicit GET method is allowed", () => {
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -X GET"]), {});
    expect(result.ok).toBe(true);
  });

  it("POS git log with args: 'git log --oneline -5' → ok", () => {
    const result = parseLoopDefinition(withShellCommands(["git log --oneline -5"]), {});
    expect(result.ok).toBe(true);
  });

  // ── Glued / equals pflag bypass cases (adversarial review findings) ───────────

  it("NEG gh api glued -XPOST: 'gh api repos/x -XPOST' → rejected", () => {
    // pflag glued form: -XPOST === -X POST; must be rejected (POST is mutating)
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -XPOST"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api equals -X=POST: 'gh api repos/x -X=POST' → rejected", () => {
    // equals form: -X=POST is another valid pflag syntax for non-GET method
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -X=POST"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api --method=POST: 'gh api repos/x --method=POST' → rejected", () => {
    // equals form for long flag: --method=POST bypasses the space-anchored regex
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --method=POST"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api glued -fbody=x: 'gh api repos/x -fbody=x' → rejected", () => {
    // pflag glued form: -fbody=x === -f body=x; must be rejected (write field)
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -fbody=x"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("NEG gh api glued -Fbody=@f: 'gh api repos/x -Fbody=@f' → rejected", () => {
    // pflag glued form: -Fbody=@f === -F body=@f; must be rejected (write field)
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -Fbody=@f"]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/gh api|field|method|mutating/i);
    }
  });

  it("POS gh api glued -XGET: 'gh api repos/x -XGET' → admitted (GET is read-only)", () => {
    // Glued GET is still read-only — must remain admitted
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x -XGET"]), {});
    expect(result.ok).toBe(true);
  });

  it("POS gh api --method=GET: 'gh api repos/x --method=GET' → admitted (GET is read-only)", () => {
    // Equals-form GET is still read-only — must remain admitted
    const result = parseLoopDefinition(withShellCommands(["gh api repos/x --method=GET"]), {});
    expect(result.ok).toBe(true);
  });
});
