/**
 * write-receipt — unit tests for emitWriteReceipt (wrgate-02) and the
 * normalizeWorkspaceRoot join-key normalization.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitWriteReceipt, normalizeWorkspaceRoot } from "../write-receipt.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-write-receipt-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("normalizeWorkspaceRoot", () => {
  it("strips a trailing worktree segment", () => {
    expect(normalizeWorkspaceRoot(join(workspace, "worktree"))).toBe(workspace);
  });

  it("is a no-op for a path that already is the workspace root", () => {
    expect(normalizeWorkspaceRoot(workspace)).toBe(workspace);
  });
});

describe("emitWriteReceipt", () => {
  it("appends exactly one write_receipt event with the given kind and path", () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "implementation_summary",
      artifact_path: join(workspace, "plans", "slug", "task-01-SUMMARY.md"),
      content: "## Implementation Summary: task-01\n\nDone.\n",
      slug: "slug",
      task_id: "task-01",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("implementation_summary");
    expect(events[0].payload.task_id).toBe("task-01");
    expect(typeof events[0].payload.written_at).toBe("string");
  });

  it("does not persist `content` onto the stored event — the event log is not a content store", () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "implementation_summary",
      artifact_path: join(workspace, "plans", "slug", "task-01-SUMMARY.md"),
      content: "## Implementation Summary: task-01\n\nDone.\n",
      slug: "slug",
      task_id: "task-01",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events[0].payload.content).toBeUndefined();
  });

  it("normalizes a worktree-rooted workspace to the same store the gate will query", () => {
    emitWriteReceipt(join(workspace, "worktree"), {
      artifact_kind: "review",
      artifact_path: join(workspace, "reviews", "REVIEW.md"),
      content: "## Canon Review — Verdict: CLEAN\n",
      slug: "slug",
    });

    // Query via the workspace ROOT — must see the event emitted via the
    // worktree-rooted path (ASSUMPTION 4 / False-Close row a).
    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("review");
  });

  it("fails open — a store error is warned, never thrown, and never surfaces to the caller", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected console.warn noise from the fail-open path */
    });
    expect(() =>
      emitWriteReceipt("/definitely/does/not/exist", {
        artifact_kind: "test_report",
        artifact_path: "/definitely/does/not/exist/plans/slug/TEST-REPORT.md",
        content: "## Test Report\n\nAll passed.\n",
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("emitWriteReceipt — finalized-only receipts (ADR-0043 amendment)", () => {
  it("does NOT emit a receipt when the written content is a `## Status: Partial` skeleton", () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "design",
      artifact_path: join(workspace, "plans", "slug", "DESIGN.md"),
      content: "## Status: Partial\n\nStill researching.\n",
      slug: "slug",
    });

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);
  });

  it("does NOT emit a receipt when the written content carries `verdict: IN_PROGRESS` frontmatter", () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "review",
      artifact_path: join(workspace, "reviews", "REVIEW.md"),
      content: "---\nverdict: IN_PROGRESS\n---\n\n## Canon Review — Verdict: IN_PROGRESS\n",
      slug: "slug",
    });

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);
  });

  it('does NOT emit a receipt when the written content carries `status: "IN_PROGRESS"` frontmatter', () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "context_sync",
      artifact_path: join(workspace, "plans", "slug", "CONTEXT-SYNC.md"),
      content: '---\nstatus: "IN_PROGRESS"\n---\n\n## Context Sync\n',
      slug: "slug",
    });

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);
  });

  it("DOES emit a receipt when the same tool is invoked again with finalized content", () => {
    emitWriteReceipt(workspace, {
      artifact_kind: "design",
      artifact_path: join(workspace, "plans", "slug", "DESIGN.md"),
      content: "## Status: Partial\n\nStill researching.\n",
      slug: "slug",
    });
    emitWriteReceipt(workspace, {
      artifact_kind: "design",
      artifact_path: join(workspace, "plans", "slug", "DESIGN.md"),
      content: "## Design: Something\n\nFull body, no longer partial.\n",
      slug: "slug",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("design");
  });
});
