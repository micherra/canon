/**
 * get-build-history tool tests.
 *
 * Tests cover: empty result, branch filter, flow filter, limit, total_count.
 * getDriftDb is mocked to avoid real SQLite I/O.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";

// ---- Mock getDriftDb ----

const mockGetArchiveManifests =
  vi.fn<(filter?: { branch?: string; flow?: string; limit?: number }) => ArchiveManifestEntry[]>();
const mockCountArchives = vi.fn<() => number>();

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(() => ({
    countArchives: mockCountArchives,
    getArchiveManifests: mockGetArchiveManifests,
  })),
}));

import { getBuildHistory } from "../tools/get-build-history.ts";

// ---- Fixtures ----

function makeArchiveEntry(overrides: Partial<ArchiveManifestEntry> = {}): ArchiveManifestEntry {
  return {
    archive_id: "arch_20260424_abc123",
    archive_path: "/tmp/.canon/history/feat--test/build-test-featur",
    archived_at: "2026-04-24T10:00:00.000Z",
    artifact_types: ["plans", "reviews"],
    branch: "feat/test",
    flow: "feature",
    has_run_summary: true,
    sanitized_branch: "feat--test",
    slug: "build-test-featur",
    source_run_id: null,
    task: "add something",
    tier: "feature",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetArchiveManifests.mockReturnValue([]);
  mockCountArchives.mockReturnValue(0);
});

// ---- Tests ----

describe("getBuildHistory", () => {
  test("returns empty archives when none exist", async () => {
    mockGetArchiveManifests.mockReturnValue([]);
    mockCountArchives.mockReturnValue(0);

    const result = await getBuildHistory({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archives).toEqual([]);
    expect(result.total_count).toBe(0);
  });

  test("returns archives from the database", async () => {
    const entry = makeArchiveEntry();
    mockGetArchiveManifests.mockReturnValue([entry]);
    mockCountArchives.mockReturnValue(1);

    const result = await getBuildHistory({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archives).toHaveLength(1);
    expect(result.archives[0].archive_id).toBe("arch_20260424_abc123");
    expect(result.total_count).toBe(1);
  });

  test("passes branch filter to getArchiveManifests", async () => {
    const entry = makeArchiveEntry({ branch: "feat/my-branch" });
    mockGetArchiveManifests.mockReturnValue([entry]);
    mockCountArchives.mockReturnValue(5);

    const result = await getBuildHistory({
      branch: "feat/my-branch",
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    expect(mockGetArchiveManifests).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feat/my-branch" }),
    );
  });

  test("passes flow filter to getArchiveManifests", async () => {
    const entry = makeArchiveEntry({ flow: "fast-path" });
    mockGetArchiveManifests.mockReturnValue([entry]);
    mockCountArchives.mockReturnValue(3);

    const result = await getBuildHistory({
      flow: "fast-path",
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    expect(mockGetArchiveManifests).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "fast-path" }),
    );
  });

  test("respects limit parameter", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeArchiveEntry({ archive_id: `arch_${i}`, slug: `slug-${i}` }),
    );
    mockGetArchiveManifests.mockReturnValue(entries.slice(0, 3));
    mockCountArchives.mockReturnValue(5);

    const result = await getBuildHistory({
      limit: 3,
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archives).toHaveLength(3);
    expect(result.total_count).toBe(5); // total_count reflects the full DB count
    expect(mockGetArchiveManifests).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
  });

  test("returns correct total_count independent of returned archives", async () => {
    // Return 2 archives but total_count is 10 (DB has more than limit)
    const entries = [
      makeArchiveEntry({ archive_id: "arch_a" }),
      makeArchiveEntry({ archive_id: "arch_b" }),
    ];
    mockGetArchiveManifests.mockReturnValue(entries);
    mockCountArchives.mockReturnValue(10);

    const result = await getBuildHistory({
      limit: 2,
      project_dir: "/tmp/proj",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archives).toHaveLength(2);
    expect(result.total_count).toBe(10);
  });

  test("uses default limit of 20 when not specified", async () => {
    mockGetArchiveManifests.mockReturnValue([]);
    mockCountArchives.mockReturnValue(0);

    await getBuildHistory({ project_dir: "/tmp/proj" });

    expect(mockGetArchiveManifests).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });
});
