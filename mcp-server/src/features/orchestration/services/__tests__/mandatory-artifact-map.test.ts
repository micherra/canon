/**
 * mandatory-artifact-map — parity tests for the write-receipt gate's
 * agent_type -> required-artifact allowlist + the exempt-step-pattern
 * grep-mirror.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXEMPT_STEP_PATTERNS, isExemptStep } from "../exempt-step-patterns.ts";
import { MANDATORY_ARTIFACT_MAP, type WriteReceiptKind } from "../mandatory-artifact-map.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEMPT_TXT_PATH = join(HERE, "..", "exempt-step-patterns.txt");

const WRITE_RECEIPT_KINDS: readonly WriteReceiptKind[] = [
  "implementation_summary",
  "review",
  "test_report",
  "design",
  "context_sync",
  "security_assessment",
  "plan_index",
];

describe("MANDATORY_ARTIFACT_MAP", () => {
  it("agent_type set is a superset of the CLAUDE.md Post-Subagent Artifact Check table", () => {
    // Source of truth: CLAUDE.md § Post-Subagent Artifact Check table lists
    // Architect, Engineer, Reviewer, Tester, Scribe. The map must cover at
    // least these — additional rows (e.g. security) are fine, a superset.
    const claudeMdTableAgents = ["architect", "engineer", "reviewer", "tester", "scribe"];
    for (const agent of claudeMdTableAgents) {
      expect(MANDATORY_ARTIFACT_MAP[agent]).toBeDefined();
    }
  });

  it("shipper / learner / evaluator / pm are structurally absent (zero-artifact agents)", () => {
    for (const agent of ["shipper", "learner", "evaluator", "pm"]) {
      expect(MANDATORY_ARTIFACT_MAP[agent]).toBeUndefined();
    }
  });

  it("every mapped agent's kinds are non-empty and a subset of WriteReceiptKind", () => {
    for (const [agentType, entry] of Object.entries(MANDATORY_ARTIFACT_MAP)) {
      expect(entry.kinds.length, `agent_type "${agentType}" has no kinds`).toBeGreaterThan(0);
      for (const kind of entry.kinds) {
        expect(WRITE_RECEIPT_KINDS, `agent_type "${agentType}" kind "${kind}"`).toContain(kind);
      }
    }
  });

  it("every mapped agent's kinds are mutually distinct across agent_types", () => {
    const seen = new Map<WriteReceiptKind, string>();
    for (const [agentType, entry] of Object.entries(MANDATORY_ARTIFACT_MAP)) {
      for (const kind of entry.kinds) {
        const owner = seen.get(kind);
        expect(
          owner,
          `kind "${kind}" claimed by both "${owner}" and "${agentType}"`,
        ).toBeUndefined();
        seen.set(kind, agentType);
      }
    }
  });

  it("every mapped agent declares at least one canonical_paths fallback entry", () => {
    for (const [agentType, entry] of Object.entries(MANDATORY_ARTIFACT_MAP)) {
      expect(entry.canonical_paths.length, agentType).toBeGreaterThan(0);
    }
  });
});

describe("exempt-step-patterns — .ts <-> .txt grep-parity", () => {
  it("the .txt mirror has exactly the same pattern sources, one per line, in order", async () => {
    const raw = await readFile(EXEMPT_TXT_PATH, "utf-8");
    const txtLines = raw.split("\n").filter((line) => line.length > 0);
    const tsSources = EXEMPT_STEP_PATTERNS.map((re) => re.source);
    expect(txtLines).toEqual(tsSources);
  });
});

describe("isExemptStep", () => {
  it("matches fix-mode, eval-fix, inline-fix, and wip- step ids", () => {
    expect(isExemptStep("fix-1")).toBe(true);
    expect(isExemptStep("eval-fix-2")).toBe(true);
    expect(isExemptStep("inline-fix")).toBe(true);
    expect(isExemptStep("wip-recovery")).toBe(true);
  });

  it("matches security-early-scan step ids (zero-artifact early-scan/inline-only mode)", () => {
    expect(isExemptStep("security-early-scan")).toBe(true);
    expect(isExemptStep("security-early-scan-1")).toBe(true);
  });

  it("does not match ordinary runbook step ids", () => {
    expect(isExemptStep("implement")).toBe(false);
    expect(isExemptStep("review")).toBe(false);
    expect(isExemptStep("design")).toBe(false);
    expect(isExemptStep("inline-fixed")).toBe(false); // must be exact "inline-fix", not a prefix
    // A real security-assessment step must NOT be swept up by the early-scan
    // exemption — the receipt guarantee stays intact for the full-scan step.
    expect(isExemptStep("security")).toBe(false);
    expect(isExemptStep("security-assessment")).toBe(false);
  });
});
