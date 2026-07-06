/**
 * reconcile-workspace tests — Phase C: source: "loop" enum widening (loops-phase-c-02)
 *
 * These tests verify:
 * - source: "loop" is accepted and flows through to telemetry (cliff detected result)
 * - source: "resume" regression still passes
 * - fail-open behavior: a workspace with no journal returns WORKSPACE_NOT_FOUND,
 *   never a hard throw
 *
 * BOUNDARY TESTS (loops-phase-c-02 P1 fix):
 * The direct-call tests above bypass the registered Zod schemas. These boundary tests
 * validate the REGISTERED schema surfaces — EventPayloadSchemas.cliff_detected and the
 * reconcile_workspace input schema — accept source: "loop". These are the surfaces that
 * rejected the value in production before the P1 fix.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { reconcileWorkspaceInputSchema } from "@app/register-journal.ts";
import { EventPayloadSchemas } from "@domains/messages/events.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileWorkspace } from "../reconcile-workspace.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-reconcile-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

/**
 * Write a minimal journal with a started step whose artifact is missing.
 * This creates a cliff scenario so reconcile returns needs_recovery: true.
 */
function writeJournalWithCliff(workspacePath: string): void {
  const journal = {
    steps: [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "started",
        artifacts_expected: ["plans/slug/SUMMARY.md"],
        started_at: new Date().toISOString(),
      },
    ],
    version: 1,
  };
  writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
}

/**
 * Write a minimal journal with a completed step (no cliff).
 */
function writeJournalClean(workspacePath: string): void {
  const journal = {
    steps: [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "completed",
        artifacts_expected: [],
        started_at: new Date().toISOString(),
      },
    ],
    version: 1,
  };
  writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
}

describe("reconcileWorkspace — source enum (loops-phase-c-02)", () => {
  it("WORKSPACE_NOT_FOUND when no journal exists (baseline)", async () => {
    const result = await reconcileWorkspace({ workspace, source: "loop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it('source: "loop" accepted — cliff scenario returns needs_recovery: true', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "loop",
      emit_telemetry: false, // avoid execution-store dependency in unit test
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
      expect(result.incomplete_steps.length).toBeGreaterThan(0);
    }
  });

  it('source: "resume" regression — still works correctly', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "resume",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
    }
  });

  it('source: "post_subagent" regression — still works correctly', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "post_subagent",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
    }
  });

  it('clean journal with source: "loop" returns needs_recovery: false', async () => {
    writeJournalClean(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "loop",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(false);
      expect(result.incomplete_steps).toHaveLength(0);
    }
  });
});

/**
 * BOUNDARY TESTS — loops-phase-c-02 P1 fix
 *
 * These tests validate the REGISTERED schema surfaces (not the direct-call impl).
 * The P1 gap: direct-call tests pass because reconcileWorkspace() accepts "loop" in its
 * TypeScript param, but the Zod schemas in register-journal.ts inputSchema and
 * events.ts EventPayloadSchemas.cliff_detected were NOT widened — so the MCP call was
 * rejected at the Zod boundary before reconcileWorkspace() ran.
 *
 * TDD red→green: These tests fail BEFORE the schema fixes (source: "loop" rejected by
 * the narrow z.enum(["resume","post_subagent"])) and pass AFTER the fixes.
 */
describe("reconcileWorkspace — registered schema boundary (loops-phase-c-02 P1)", () => {
  it('EventPayloadSchemas.cliff_detected accepts source: "loop"', () => {
    const payload = {
      incomplete_step_ids: ["implement"],
      missing_count: 1,
      partial_count: 0,
      needs_recovery: true as const,
      source: "loop" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("EventPayloadSchemas.cliff_detected rejects unknown source (schema is not too wide)", () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "unknown_source",
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('EventPayloadSchemas.cliff_detected still accepts source: "resume" (regression)', () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "resume" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('EventPayloadSchemas.cliff_detected still accepts source: "post_subagent" (regression)', () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "post_subagent" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema accepts source: "loop"', () => {
    const input = {
      workspace: "/tmp/test-workspace",
      source: "loop" as const,
      emit_telemetry: false,
    };
    const result = reconcileWorkspaceInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema still accepts source: "resume" (regression)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "resume",
    });
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema still accepts source: "post_subagent" (regression)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "post_subagent",
    });
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema rejects source: "unknown" (schema is not too wide)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "unknown",
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Cliff-transcript capture (cliff-transcript-01) — reconcileWorkspace best-effort
 * threads a transcript snapshot (or typed absent-marker) into IncompleteStep,
 * the cliff_detected event, and the drift.db cliff_events row.
 */
describe("reconcileWorkspace — cliff-transcript capture (cliff-transcript-01)", () => {
  const SESSION_ID = "session-reconcile-capture";
  // NOTE: reconcile_workspace's single `projectDir` input serves both purposes —
  // locating drift.db AND (now) locating the Claude Code projects dir for
  // transcript resolution — so the fixture must be planted under THIS same
  // value, not a separate fake path.
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "canon-reconcile-drift-"));
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    evictDriftDbForScope(projectDir);
    await rm(projectDir, { force: true, recursive: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
  });

  function writeJournalWithSession(workspacePath: string): void {
    const journal = {
      session_id: SESSION_ID,
      steps: [
        {
          agent_type: "canon:engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
  }

  function plantFixture(homeDir: string): void {
    const projectId = projectDir.replace(/\//g, "-");
    const dir = join(homeDir, ".claude", "projects", projectId, SESSION_ID, "subagents");
    mkdirSync(dir, { recursive: true });
    const entries = [
      {
        agentId: "irrelevant",
        isSidechain: true,
        message: { content: "hi", role: "user" },
        parentUuid: "parent",
        timestamp: new Date().toISOString(),
        type: "user",
      },
    ];
    writeFileSync(
      join(dir, "agent-aengineer-implement-jobsfx-hash.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n"),
      "utf-8",
    );
  }

  it("cliff + fixture file: IncompleteStep.transcript_path set, and both the cliff_detected event and the drift.db row carry the path", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace); // ensure the execution store exists for appendEvent
    writeJournalWithSession(workspace);
    plantFixture(homeDir);

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.incomplete_steps.find((s) => s.step_id === "implement");
      expect(step?.transcript_path).toBeDefined();
      expect(step?.transcript_path).toContain(join(workspace, "transcripts"));

      const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
      const payload = events[0].payload as {
        steps: Array<{ step_id: string; transcript_path?: string }>;
      };
      const eventStep = payload.steps.find((s) => s.step_id === "implement");
      expect(eventStep?.transcript_path).toBe(step?.transcript_path);

      const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
      const row = rows.find((r) => r.step_id === "implement");
      expect(row?.transcript_path).toBe(step?.transcript_path);
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("cliff + no fixture file: transcript_uncaptured_reason populated, tool output otherwise unchanged", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace);
    writeJournalWithSession(workspace);
    // No fixture planted — subagents dir exists but empty is optional; leave absent.

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.needs_recovery).toBe(true);
      const step = result.incomplete_steps.find((s) => s.step_id === "implement");
      expect(step?.transcript_path).toBeUndefined();
      expect(step?.transcript_uncaptured_reason).toBe("projects_dir_unreadable");

      const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
      const row = rows.find((r) => r.step_id === "implement");
      expect(row?.transcript_uncaptured_reason).toBe("projects_dir_unreadable");
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("journal without session_id: no_session_id marker, never a cross-session guess", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace);
    plantFixture(homeDir);
    // Journal WITHOUT session_id.
    const journal = {
      steps: [
        {
          agent_type: "canon:engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal, null, 2));

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.incomplete_steps.find((s) => s.step_id === "implement");
      expect(step?.transcript_path).toBeUndefined();
      expect(step?.transcript_uncaptured_reason).toBe("no_session_id");
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("no cliff: capture is never attempted (spy) — clean-path output identical to today", async () => {
    vi.resetModules();
    vi.doMock("../../services/cliff-transcript-capture.ts", () => ({
      captureCliffTranscripts: vi.fn(),
    }));
    const captureModule = await import("../../services/cliff-transcript-capture.ts");
    const { reconcileWorkspace: reconcileWorkspaceFresh } = await import(
      "../reconcile-workspace.ts"
    );

    // Clean journal: a completed step, no missing artifacts.
    const journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: [],
          started_at: new Date().toISOString(),
          status: "completed",
          step_id: "implement",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal, null, 2));

    try {
      const result = await reconcileWorkspaceFresh({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.needs_recovery).toBe(false);
      expect(result.incomplete_steps).toHaveLength(0);
      expect(captureModule.captureCliffTranscripts).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../services/cliff-transcript-capture.ts");
      vi.resetModules();
    }
  });

  /** Plant a fixture for an arbitrary shortType/stepId pair (the shared
   * plantFixture above is hardcoded to canon:engineer/implement). */
  function plantFixtureFor(homeDir: string, shortType: string, stepId: string): void {
    const projectId = projectDir.replace(/\//g, "-");
    const dir = join(homeDir, ".claude", "projects", projectId, SESSION_ID, "subagents");
    mkdirSync(dir, { recursive: true });
    const entries = [
      {
        isSidechain: true,
        message: { content: "user turn", role: "user" },
        timestamp: "2026-07-06T00:00:00.000Z",
        type: "user",
      },
      {
        isSidechain: true,
        message: { content: "assistant turn", role: "assistant" },
        timestamp: "2026-07-06T00:00:01.000Z",
        type: "assistant",
      },
    ];
    writeFileSync(
      join(dir, `agent-a${shortType}-${stepId}-jobsfx-hash.jsonl`),
      entries.map((e) => JSON.stringify(e)).join("\n"),
      "utf-8",
    );
  }

  it("full loop: the persisted transcript file physically exists and is transformed Canon TranscriptEntry JSONL, not raw CC entries", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace);
    writeJournalWithSession(workspace);
    plantFixtureFor(homeDir, "engineer", "implement");

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.incomplete_steps.find((s) => s.step_id === "implement");
      const transcriptPath = step?.transcript_path;
      expect(transcriptPath).toBeDefined();
      if (!transcriptPath) return;

      // Physically on disk, under the workspace's transcripts/ dir.
      const raw = readFileSync(transcriptPath, "utf-8");
      expect(transcriptPath).toContain(join(workspace, "transcripts"));

      const lines = raw.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const parsed = lines.map((l) => JSON.parse(l));

      for (const entry of parsed) {
        // Canon TranscriptEntry shape: turn_number + role + content + timestamp.
        expect(entry).toHaveProperty("turn_number");
        expect(entry).toHaveProperty("role");
        expect(entry).toHaveProperty("content");
        expect(entry).toHaveProperty("timestamp");
        // Raw CC-only fields must NOT survive the transform.
        expect(entry).not.toHaveProperty("isSidechain");
        expect(entry).not.toHaveProperty("agentId");
        expect(entry).not.toHaveProperty("message");
      }
      expect(parsed.map((e) => e.role)).toEqual(["user", "assistant"]);
      expect(parsed.map((e) => e.content)).toEqual(["user turn", "assistant turn"]);

      // Same path threaded into the durable drift.db row.
      const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
      const row = rows.find((r) => r.step_id === "implement");
      expect(row?.transcript_path).toBe(transcriptPath);
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("absent-marker distinction: session dir exists but no matching agent file yields no_source_match (vs projects_dir_unreadable when the dir is absent)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace);
    writeJournalWithSession(workspace);
    // Create the session's subagents dir but plant no matching fixture file —
    // distinct from the "cliff + no fixture" test above, where the whole
    // projects dir tree is absent (-> projects_dir_unreadable).
    const projectId = projectDir.replace(/\//g, "-");
    mkdirSync(join(homeDir, ".claude", "projects", projectId, SESSION_ID, "subagents"), {
      recursive: true,
    });

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.incomplete_steps.find((s) => s.step_id === "implement");
      expect(step?.transcript_path).toBeUndefined();
      expect(step?.transcript_uncaptured_reason).toBe("no_source_match");

      const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
      const row = rows.find((r) => r.step_id === "implement");
      expect(row?.transcript_uncaptured_reason).toBe("no_source_match");
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("topology: two cliffed steps in one reconcile call resolve independently (partial success), both rows written with correct per-step fields", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "canon-reconcile-home-"));
    process.env.HOME = homeDir;
    getExecutionStore(workspace);

    // Two started steps: "implement" (fixture present) and "review" (no fixture).
    const journal = {
      session_id: SESSION_ID,
      steps: [
        {
          agent_type: "canon:engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
        {
          agent_type: "canon:reviewer",
          artifacts_expected: ["reviews/REVIEW.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "review",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal, null, 2));
    // Only "implement" gets a matching fixture; "review"'s token never matches
    // anything in the (existing, non-empty) subagents dir -> no_source_match.
    plantFixtureFor(homeDir, "engineer", "implement");

    try {
      const result = await reconcileWorkspace({
        workspace,
        emit_telemetry: true,
        projectDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.incomplete_steps).toHaveLength(2);

      const implementStep = result.incomplete_steps.find((s) => s.step_id === "implement");
      const reviewStep = result.incomplete_steps.find((s) => s.step_id === "review");

      expect(implementStep?.transcript_path).toBeDefined();
      expect(implementStep?.transcript_uncaptured_reason).toBeUndefined();
      expect(reviewStep?.transcript_path).toBeUndefined();
      expect(reviewStep?.transcript_uncaptured_reason).toBe("no_source_match");

      // Both durable drift.db rows exist with their own, independent fields.
      const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
      const implementRow = rows.find((r) => r.step_id === "implement");
      const reviewRow = rows.find((r) => r.step_id === "review");
      expect(implementRow?.transcript_path).toBe(implementStep?.transcript_path);
      expect(implementRow?.transcript_uncaptured_reason).toBeNull();
      expect(reviewRow?.transcript_path).toBeNull();
      expect(reviewRow?.transcript_uncaptured_reason).toBe("no_source_match");

      // The cliff_detected event also carries independent per-step fields.
      const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
      const payload = events[0].payload as {
        steps: Array<{
          step_id: string;
          transcript_path?: string;
          transcript_uncaptured_reason?: string;
        }>;
      };
      const eventImplement = payload.steps.find((s) => s.step_id === "implement");
      const eventReview = payload.steps.find((s) => s.step_id === "review");
      expect(eventImplement?.transcript_path).toBe(implementStep?.transcript_path);
      expect(eventReview?.transcript_uncaptured_reason).toBe("no_source_match");
    } finally {
      await rm(homeDir, { force: true, recursive: true });
    }
  });
});
