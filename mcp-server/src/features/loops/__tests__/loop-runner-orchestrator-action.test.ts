/**
 * Loop runner orchestrator_action surfacing test (AC4 — Phase B+)
 *
 * Proves the runner's Step 6 generic surfacing logic is value-agnostic:
 * the SAME pure function produces the correct `ORCHESTRATOR_ACTION:` line
 * for BOTH `auto-triage-fix` and `auto-plugin-update` with zero per-action
 * branching — mirrors the loop-runner-first-tick.test.ts pattern.
 *
 * The runner is an agentic markdown skill (not TypeScript), so we model its
 * Step 6 behavior via a pure function and test the contract the markdown
 * instruction encodes: "if a fired rule carries orchestrator_action, emit
 * `ORCHESTRATOR_ACTION: <action> field=<field> loop=<id>`".
 *
 * AC4 (from task-plan orchestrator-action-01):
 * - rule with auto-triage-fix → exact ORCHESTRATOR_ACTION: line
 * - rule with auto-plugin-update → exact ORCHESTRATOR_ACTION: line (same fn, no branching)
 * - rule without orchestrator_action → null (no signal line)
 */

import { describe, expect, it } from "vitest";
import type { OrchestratorAction } from "../loop-schema.ts";

// ── Pure surfacing model (models loop-tick.md Step 6) ──────────────────────────
// Given a fired rule and a loop id, returns the structured signal line when
// the rule carries orchestrator_action, or null when it does not.
// This is the SAME function for every vocabulary member — no per-action branching.

type FiredRule = {
  field: string;
  message: string;
  orchestrator_action?: OrchestratorAction;
  terminate?: boolean;
};

/**
 * Models the runner Step 6 orchestrator_action surfacing instruction.
 * Value-agnostic: substitutes rule.orchestrator_action verbatim — one function
 * for every vocabulary member, with zero per-action special-casing.
 */
function surfaceLine(rule: FiredRule, loopId: string): string | null {
  if (rule.orchestrator_action === undefined) {
    return null;
  }
  return `ORCHESTRATOR_ACTION: ${rule.orchestrator_action} field=${rule.field} loop=${loopId}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runner orchestrator_action surfacing (AC4 — value-agnostic)", () => {
  it("rule with auto-triage-fix → correct ORCHESTRATOR_ACTION line (external_review_comment_ids)", () => {
    const rule: FiredRule = {
      field: "external_review_comment_ids",
      message: "New external review comment(s) on the PR — surfacing for triage.",
      orchestrator_action: "auto-triage-fix",
      terminate: undefined,
    };
    const line = surfaceLine(rule, "ship-watch");
    expect(line).toBe(
      "ORCHESTRATOR_ACTION: auto-triage-fix field=external_review_comment_ids loop=ship-watch",
    );
  });

  it("rule with auto-plugin-update → correct ORCHESTRATOR_ACTION line (release_tag)", () => {
    const rule: FiredRule = {
      field: "release_tag",
      message: "Release tag cut — reminder: run plugin-update so the new version goes live.",
      orchestrator_action: "auto-plugin-update",
    };
    const line = surfaceLine(rule, "ship-watch");
    expect(line).toBe("ORCHESTRATOR_ACTION: auto-plugin-update field=release_tag loop=ship-watch");
  });

  it("same function produces correct line for BOTH action values — value-agnostic proof", () => {
    // Both values go through the SAME surfaceLine call — no per-action branching
    const ruleA: FiredRule = {
      field: "external_review_comment_ids",
      message: "msg",
      orchestrator_action: "auto-triage-fix",
    };
    const ruleB: FiredRule = {
      field: "release_tag",
      message: "msg",
      orchestrator_action: "auto-plugin-update",
    };
    const lineA = surfaceLine(ruleA, "ship-watch");
    const lineB = surfaceLine(ruleB, "ship-watch");
    // Both must produce a non-null line (same function, different substitution)
    expect(lineA).not.toBeNull();
    expect(lineB).not.toBeNull();
    // Neither must contain the other's action value — distinct substitution confirmed
    expect(lineA).toContain("auto-triage-fix");
    expect(lineA).not.toContain("auto-plugin-update");
    expect(lineB).toContain("auto-plugin-update");
    expect(lineB).not.toContain("auto-triage-fix");
  });

  it("rule with run-learner → correct ORCHESTRATOR_ACTION line (learner_due)", () => {
    const rule: FiredRule = {
      field: "learner_due",
      message: "Accumulated build signal crossed the learner threshold — surfacing a learner pass.",
      orchestrator_action: "run-learner",
      terminate: true,
    };
    const line = surfaceLine(rule, "harness-watch");
    expect(line).toBe("ORCHESTRATOR_ACTION: run-learner field=learner_due loop=harness-watch");
  });

  it("rule without orchestrator_action → null (no signal line)", () => {
    const rule: FiredRule = {
      field: "ci_conclusion",
      message: "CI status changed.",
      // orchestrator_action absent
    };
    const line = surfaceLine(rule, "ship-watch");
    expect(line).toBeNull();
  });

  it("surfaceLine format: ORCHESTRATOR_ACTION: <action> field=<field> loop=<id>", () => {
    // Structural contract: action, field, loop id present and in correct order
    const rule: FiredRule = {
      field: "ci_conclusion",
      message: "CI failed.",
      orchestrator_action: "auto-triage-fix",
      terminate: true,
    };
    const line = surfaceLine(rule, "ship-watch");
    expect(line).toMatch(
      /^ORCHESTRATOR_ACTION: auto-triage-fix field=ci_conclusion loop=ship-watch$/,
    );
  });
});
