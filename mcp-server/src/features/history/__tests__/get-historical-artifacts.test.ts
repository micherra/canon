/**
 * get-historical-artifacts tool tests.
 *
 * Tests cover: unknown archive ID, artifact retrieval, artifact_types filter,
 * run-summary special case, path traversal prevention, missing directory.
 * getDriftDb is mocked; real tmp directories are used for file I/O.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";

// ---- Mock getDriftDb ----

const mockGetArchiveById = vi.fn<(id: string) => ArchiveManifestEntry | null>();

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(() => ({
    getArchiveById: mockGetArchiveById,
  })),
}));

import { getHistoricalArtifacts } from "../tools/get-historical-artifacts.ts";

// ---- Helpers ----

let tmpDir: string;
let archivePath: string;

function makeArchiveEntry(overrides: Partial<ArchiveManifestEntry> = {}): ArchiveManifestEntry {
  return {
    archive_id: "arch_test_001",
    archive_path: archivePath,
    archived_at: "2026-04-24T10:00:00.000Z",
    artifact_types: ["plans"],
    branch: "feat/test",
    flow: "feature",
    has_run_summary: true,
    sanitized_branch: "feat--test",
    slug: "test-slug",
    source_run_id: null,
    task: "test task",
    tier: "feature",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `hist-artifacts-test-${randomBytes(6).toString("hex")}`);
  archivePath = join(tmpDir, "archive");
  mkdirSync(archivePath, { recursive: true });
  vi.clearAllMocks();
  mockGetArchiveById.mockReturnValue(null);
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

// ---- Tests ----

describe("getHistoricalArtifacts", () => {
  test("returns WORKSPACE_NOT_FOUND for unknown archive_id", async () => {
    mockGetArchiveById.mockReturnValue(null);

    const result = await getHistoricalArtifacts({
      archive_id: "nonexistent_id",
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain("nonexistent_id");
  });

  test("returns artifact content for valid archive_id", async () => {
    const plansDir = join(archivePath, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "PLAN.md"), "# Plan content");

    mockGetArchiveById.mockReturnValue(makeArchiveEntry());

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: ["plans"],
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive_id).toBe("arch_test_001");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe("plans/PLAN.md");
    expect(result.artifacts[0].content).toBe("# Plan content");
  });

  test("filters by artifact_types when provided", async () => {
    // Create both plans and reviews directories
    const plansDir = join(archivePath, "plans");
    const reviewsDir = join(archivePath, "reviews");
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(plansDir, "PLAN.md"), "Plan");
    writeFileSync(join(reviewsDir, "REVIEW.md"), "Review");

    mockGetArchiveById.mockReturnValue(makeArchiveEntry());

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: ["plans"], // Only request plans
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should only include plans, not reviews
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe("plans/PLAN.md");
  });

  test("returns run-summary.json when artifact_type 'run-summary' requested", async () => {
    const summary = { archive_id: "arch_test_001", version: 1 };
    writeFileSync(join(archivePath, "run-summary.json"), JSON.stringify(summary));

    mockGetArchiveById.mockReturnValue(makeArchiveEntry({ has_run_summary: true }));

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: ["run-summary"],
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe("run-summary.json");
    expect(result.artifacts[0].content).toContain("archive_id");
  });

  test("prevents directory traversal with .. in artifact_types", async () => {
    // Create a file outside the archive root
    const outsideFile = join(tmpDir, "secret.txt");
    writeFileSync(outsideFile, "secret content");

    mockGetArchiveById.mockReturnValue(makeArchiveEntry());

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: ["../secret"],
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Path traversal is blocked — no artifacts from outside archive
    expect(result.artifacts).toHaveLength(0);
  });

  test("handles missing archive directory gracefully", async () => {
    // Point archive to a non-existent path
    const entry = makeArchiveEntry({ archive_path: "/nonexistent/archive/path" });
    mockGetArchiveById.mockReturnValue(entry);

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain("no longer exists");
  });

  test("filters by file_pattern when provided", async () => {
    const plansDir = join(archivePath, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "PLAN.md"), "Plan content");
    writeFileSync(join(plansDir, "DESIGN.md"), "Design content");

    mockGetArchiveById.mockReturnValue(makeArchiveEntry());

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: ["plans"],
      file_pattern: "PLAN",
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only PLAN.md matches the pattern
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe("plans/PLAN.md");
  });

  test("returns archive_id and archive_path in result", async () => {
    mockGetArchiveById.mockReturnValue(makeArchiveEntry());

    const result = await getHistoricalArtifacts({
      archive_id: "arch_test_001",
      artifact_types: [], // No artifact types to read
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive_id).toBe("arch_test_001");
    expect(result.archive_path).toBe(archivePath);
  });
});
