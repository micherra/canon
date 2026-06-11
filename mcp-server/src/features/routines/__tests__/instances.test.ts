/**
 * instances.test.ts — Integration test for the three real routine instances.
 *
 * Oracle contract (from task plan routines-06):
 * - Each instance passes lintRoutines with zero findings (PRD AC#11/AC#1)
 * - resolveBinding yields cloud/cloud/desktop respectively (AC#11)
 * - routines/.claude/CLAUDE.md byte-matches generateRoutinesIndex([...the three...]) (AC#3)
 * - release-ahead and pr-review bodies contain no `.canon` substring (fresh-clone-runnable, AC#10)
 * - canon-maintenance resolves desktop and has repo_writes:draft-pr (AC#12 reconciliation)
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRoutineFile } from "@shared/routine.ts";
import { describe, expect, it } from "vitest";
import { resolveBinding } from "../services/resolve-binding.ts";
import { generateRoutinesIndex } from "../services/routine-index.ts";
import { lintRoutines } from "../services/routine-lint.ts";

// ---------------------------------------------------------------------------
// Paths — relative to the repo root (worktree root)
// ---------------------------------------------------------------------------

// mcp-server lives at <root>/mcp-server, so we go up two levels from __tests__
const REPO_ROOT = resolve(__dirname, "../../../../..");
const ROUTINES_DIR = join(REPO_ROOT, "routines");

function routinePath(name: string): string {
  return join(ROUTINES_DIR, `${name}.md`);
}

const CLAUDE_INDEX_PATH = join(ROUTINES_DIR, ".claude", "CLAUDE.md");

// ---------------------------------------------------------------------------
// Load all three instances once (shared across tests)
// ---------------------------------------------------------------------------

async function loadInstances() {
  const [releaseAhead, prReview, canonMaintenance] = await Promise.all([
    loadRoutineFile(routinePath("release-ahead"), "project"),
    loadRoutineFile(routinePath("pr-review"), "project"),
    loadRoutineFile(routinePath("canon-maintenance"), "project"),
  ]);
  return { releaseAhead, prReview, canonMaintenance };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routine instances — parse and identity", () => {
  it("release-ahead loads with correct name and status", async () => {
    const { releaseAhead } = await loadInstances();
    expect(releaseAhead.name).toBe("release-ahead");
    expect(releaseAhead.status).not.toBe("");
    expect(releaseAhead.title).toBeTruthy();
  });

  it("pr-review loads with correct name and status", async () => {
    const { prReview } = await loadInstances();
    expect(prReview.name).toBe("pr-review");
    expect(prReview.status).not.toBe("");
    expect(prReview.title).toBeTruthy();
  });

  it("canon-maintenance loads with correct name and status", async () => {
    const { canonMaintenance } = await loadInstances();
    expect(canonMaintenance.name).toBe("canon-maintenance");
    expect(canonMaintenance.status).not.toBe("");
    expect(canonMaintenance.title).toBeTruthy();
  });
});

describe("routine instances — lint clean (AC#11/AC#1)", () => {
  it("release-ahead has zero lint findings", async () => {
    const { releaseAhead } = await loadInstances();
    const findings = lintRoutines([releaseAhead]);
    expect(findings).toEqual([]);
  });

  it("pr-review has zero lint findings", async () => {
    const { prReview } = await loadInstances();
    const findings = lintRoutines([prReview]);
    expect(findings).toEqual([]);
  });

  it("canon-maintenance has zero lint findings", async () => {
    const { canonMaintenance } = await loadInstances();
    const findings = lintRoutines([canonMaintenance]);
    expect(findings).toEqual([]);
  });

  it("all three together have zero lint findings", async () => {
    const { releaseAhead, prReview, canonMaintenance } = await loadInstances();
    const findings = lintRoutines([releaseAhead, prReview, canonMaintenance]);
    expect(findings).toEqual([]);
  });
});

describe("routine instances — binding resolution (AC#11)", () => {
  it("release-ahead resolves to cloud-routine (git-native + daemon:false)", async () => {
    const { releaseAhead } = await loadInstances();
    expect(resolveBinding(releaseAhead.needs)).toBe("cloud-routine");
  });

  it("pr-review resolves to cloud-routine (git-native + daemon:false)", async () => {
    const { prReview } = await loadInstances();
    expect(resolveBinding(prReview.needs)).toBe("cloud-routine");
  });

  it("canon-maintenance resolves to desktop-task (local-canon or daemon:true)", async () => {
    const { canonMaintenance } = await loadInstances();
    expect(resolveBinding(canonMaintenance.needs)).toBe("desktop-task");
  });
});

describe("routine instances — fresh-clone-runnability (AC#10)", () => {
  it("release-ahead body contains no .canon substring", async () => {
    const { releaseAhead } = await loadInstances();
    expect(releaseAhead.body).not.toContain(".canon");
  });

  it("pr-review body contains no .canon substring", async () => {
    const { prReview } = await loadInstances();
    expect(prReview.body).not.toContain(".canon");
  });
});

describe("routine instances — AC#12 reconciliation (canon-maintenance desktop constraints)", () => {
  it("canon-maintenance has repo_writes:draft-pr", async () => {
    const { canonMaintenance } = await loadInstances();
    expect(canonMaintenance.guardrails.repo_writes).toBe("draft-pr");
  });

  it("canon-maintenance has mutates_running_build:false (adaptive-queen invariant)", async () => {
    const { canonMaintenance } = await loadInstances();
    expect(canonMaintenance.guardrails.mutates_running_build).toBe(false);
  });

  it("canon-maintenance has consent:opt-in (required for standing draft-pr routines)", async () => {
    const { canonMaintenance } = await loadInstances();
    expect(canonMaintenance.guardrails.consent).toBe("opt-in");
  });
});

describe("routines/.claude/CLAUDE.md — generated index byte-match (AC#3)", () => {
  it("CLAUDE.md byte-matches generateRoutinesIndex output for these three instances", async () => {
    const { releaseAhead, prReview, canonMaintenance } = await loadInstances();

    // Generate expected content from the real generator
    const expectedContent = generateRoutinesIndex([releaseAhead, prReview, canonMaintenance]);

    // Read actual file on disk
    const actualContent = await readFile(CLAUDE_INDEX_PATH, "utf-8");

    expect(actualContent).toBe(expectedContent);
  });
});
