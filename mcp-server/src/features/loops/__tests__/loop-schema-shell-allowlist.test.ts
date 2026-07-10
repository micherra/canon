/**
 * loop-schema READ_ONLY_SHELL_COMMANDS extension tests (staleness-01)
 *
 * Proves the `stat`, `date`, `git rev-parse` allowlist additions (dec-06):
 * - Each new command's genuinely-read-only form is admitted
 * - A mutating sibling of each new prefix still rejects fail-closed (the
 *   security-critical assertion for expanding a shell allowlist)
 *
 * Placed in a separate file to keep loop-schema.test.ts under the 600-line Biome limit
 * (same precedent as loop-schema-orchestrator-action.test.ts).
 */

import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// Minimal valid interval loop definition (same base shape as loop-schema.test.ts)
const validIntervalFrontmatter = {
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

describe("parseLoopDefinition — READ_ONLY_SHELL_COMMANDS extension (staleness-01)", () => {
  it("[POSITIVE] Bash + shell_commands:['stat', 'date +%s', 'git rev-parse'] + mutates_build:false → ok", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["stat -f %m /tmp/x", "date +%s", "git rev-parse HEAD"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("[NEGATIVE 'git commit']: mutating sibling of 'git rev-parse' → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["git commit -m x"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/git commit|allowlist/i);
    }
  });

  it("[NEGATIVE 'rm']: mutating sibling of 'stat' → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["rm -rf /tmp/x"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/rm|allowlist/i);
    }
  });

  it("[NEGATIVE 'date -s']: mutating set-clock flag on 'date' → rejected (bare 'date' prefix, argument-level gate)", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date -s '2026-01-01'"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/date|-s|clock/i);
    }
  });

  it("[NEGATIVE 'date --set']: glued long-form set-clock flag on 'date' → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date --set=2026-01-01"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/date|--set|clock/i);
    }
  });

  it("[REGRESSION] bare 'date' with no args still admitted (read-only, no set-clock flag)", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  // ── BSD positional clock-set gap (Finding 1, review + security fix) ──────────
  // `/bin/date` on BSD/macOS (the runner's platform) sets the system clock via a bare
  // positional operand — no flag at all. The prior `-s`/`--set` guard admitted this
  // unconditionally. These assertions prove the gap is closed without over-rejecting
  // the legitimate read-only forms security flagged (`-r <epoch>` in particular).

  it("[NEGATIVE 'date <digits>']: BSD positional clock-set operand → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date 202601010000"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/date|clock/i);
    }
  });

  it("[NEGATIVE 'date <digits>.<ss>']: BSD positional clock-set operand with seconds → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date 1231235926.59"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/date|clock/i);
    }
  });

  it("[REGRESSION] 'date +%s' still admitted (format token, not a clock-set operand)", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date +%s"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("[REGRESSION] 'date -u' still admitted", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date -u"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("[REGRESSION] 'date -r 1234567890' still admitted (BSD read-given-epoch, digit operand is NOT a clock-set — the false-reject trap)", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date -r 1234567890"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("[REGRESSION] 'date -d \"2020-01-01\"' still admitted (GNU read-given-date)", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ['date -d "2020-01-01"'],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("[REGRESSION] 'date -Iseconds' still admitted (BSD do-not-set / ISO-output style flag)", () => {
    const good = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Bash"],
        mcp: [],
        shell_commands: ["date -Iseconds"],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });
});
