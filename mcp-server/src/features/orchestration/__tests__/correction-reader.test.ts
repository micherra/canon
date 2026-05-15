import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CorrectionRecord,
  formatCorrectionsSection,
  readCorrections,
} from "@features/orchestration/services/correction-reader.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function seedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canon-corrections-test-"));
  return dir;
}

function writeCorrection(
  projectDir: string,
  fileName: string,
  record: Partial<CorrectionRecord> & { file_path: string; timestamp: string },
) {
  const dir = join(projectDir, ".canon", "corrections");
  mkdirSync(dir, { recursive: true });
  const full: CorrectionRecord = {
    agent_type: "engineer",
    commit_sha: "abc12345",
    commit_subject: "feat: add feature",
    correction_command: "git commit --amend",
    ...record,
  };
  writeFileSync(join(dir, fileName), JSON.stringify(full));
}

function recentTimestamp(offsetMs = 0): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

describe("readCorrections", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = seedProjectDir();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("returns empty array when corrections directory does not exist", () => {
    // projectDir exists but no .canon/corrections dir
    const result = readCorrections(projectDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when directory is empty", () => {
    mkdirSync(join(projectDir, ".canon", "corrections"), { recursive: true });
    const result = readCorrections(projectDir);
    expect(result).toEqual([]);
  });

  it("reads a valid correction JSON file", () => {
    writeCorrection(projectDir, "correction-001.json", {
      file_path: "src/foo.ts",
      timestamp: recentTimestamp(),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/foo.ts");
    expect(result[0].agent_type).toBe("engineer");
  });

  it("reads multiple valid correction JSON files", () => {
    writeCorrection(projectDir, "correction-001.json", {
      file_path: "src/foo.ts",
      timestamp: recentTimestamp(5000),
    });
    writeCorrection(projectDir, "correction-002.json", {
      file_path: "src/bar.ts",
      timestamp: recentTimestamp(1000),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(2);
  });

  it("skips malformed JSON files without error", () => {
    const dir = join(projectDir, ".canon", "corrections");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{ this is not json }");
    writeCorrection(projectDir, "good.json", {
      file_path: "src/good.ts",
      timestamp: recentTimestamp(),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/good.ts");
  });

  it("filters by file paths when provided", () => {
    writeCorrection(projectDir, "c1.json", {
      file_path: "src/wanted.ts",
      timestamp: recentTimestamp(),
    });
    writeCorrection(projectDir, "c2.json", {
      file_path: "src/unwanted.ts",
      timestamp: recentTimestamp(1000),
    });
    const result = readCorrections(projectDir, ["src/wanted.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/wanted.ts");
  });

  it("returns all corrections when filePaths filter is undefined", () => {
    writeCorrection(projectDir, "c1.json", {
      file_path: "src/a.ts",
      timestamp: recentTimestamp(),
    });
    writeCorrection(projectDir, "c2.json", {
      file_path: "src/b.ts",
      timestamp: recentTimestamp(1000),
    });
    const result = readCorrections(projectDir, undefined);
    expect(result).toHaveLength(2);
  });

  it("excludes corrections older than maxAge", () => {
    const twentyFiveHoursMs = 25 * 60 * 60 * 1000;
    const tenMinutesMs = 10 * 60 * 1000;
    writeCorrection(projectDir, "old.json", {
      file_path: "src/old.ts",
      timestamp: recentTimestamp(twentyFiveHoursMs),
    });
    writeCorrection(projectDir, "recent.json", {
      file_path: "src/recent.ts",
      timestamp: recentTimestamp(tenMinutesMs),
    });
    // Default maxAge is 24 hours
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/recent.ts");
  });

  it("respects custom maxAge parameter", () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    writeCorrection(projectDir, "six-hours-ago.json", {
      file_path: "src/old.ts",
      timestamp: recentTimestamp(sixHoursMs),
    });
    writeCorrection(projectDir, "two-hours-ago.json", {
      file_path: "src/recent.ts",
      timestamp: recentTimestamp(twoHoursMs),
    });
    // Custom maxAge: 3 hours
    const result = readCorrections(projectDir, undefined, 3 * 60 * 60 * 1000);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/recent.ts");
  });

  it("sorts results by timestamp DESC (most recent first)", () => {
    writeCorrection(projectDir, "c1.json", {
      file_path: "src/oldest.ts",
      timestamp: recentTimestamp(30 * 60 * 1000),
    });
    writeCorrection(projectDir, "c2.json", {
      file_path: "src/newest.ts",
      timestamp: recentTimestamp(5 * 60 * 1000),
    });
    writeCorrection(projectDir, "c3.json", {
      file_path: "src/middle.ts",
      timestamp: recentTimestamp(15 * 60 * 1000),
    });
    const result = readCorrections(projectDir);
    expect(result[0].file_path).toBe("src/newest.ts");
    expect(result[1].file_path).toBe("src/middle.ts");
    expect(result[2].file_path).toBe("src/oldest.ts");
  });

  it("skips records missing required file_path field", () => {
    const dir = join(projectDir, ".canon", "corrections");
    mkdirSync(dir, { recursive: true });
    // Missing file_path
    writeFileSync(
      join(dir, "no-filepath.json"),
      JSON.stringify({
        agent_type: "engineer",
        commit_sha: "abc123",
        commit_subject: "test",
        correction_command: "git commit",
        timestamp: recentTimestamp(),
      }),
    );
    writeCorrection(projectDir, "valid.json", {
      file_path: "src/valid.ts",
      timestamp: recentTimestamp(1000),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/valid.ts");
  });

  it("skips records missing required timestamp field", () => {
    const dir = join(projectDir, ".canon", "corrections");
    mkdirSync(dir, { recursive: true });
    // Missing timestamp
    writeFileSync(
      join(dir, "no-timestamp.json"),
      JSON.stringify({
        agent_type: "engineer",
        commit_sha: "abc123",
        commit_subject: "test",
        correction_command: "git commit",
        file_path: "src/foo.ts",
      }),
    );
    writeCorrection(projectDir, "valid.json", {
      file_path: "src/valid.ts",
      timestamp: recentTimestamp(1000),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/valid.ts");
  });

  it("ignores non-.json files in the corrections directory", () => {
    const dir = join(projectDir, ".canon", "corrections");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "correction.txt"), "not json");
    writeFileSync(join(dir, ".gitkeep"), "");
    writeCorrection(projectDir, "valid.json", {
      file_path: "src/valid.ts",
      timestamp: recentTimestamp(),
    });
    const result = readCorrections(projectDir);
    expect(result).toHaveLength(1);
  });
});

describe("formatCorrectionsSection", () => {
  it("returns empty string for empty array", () => {
    const result = formatCorrectionsSection([]);
    expect(result).toBe("");
  });

  it("produces markdown with file path, truncated commit SHA, and correction command", () => {
    const corrections: CorrectionRecord[] = [
      {
        agent_type: "engineer",
        commit_sha: "abc12345def67890",
        commit_subject: "feat: add something",
        correction_command: "git commit --amend --no-edit",
        file_path: "src/services/my-service.ts",
        timestamp: "2026-05-15T10:00:00.000Z",
      },
    ];
    const result = formatCorrectionsSection(corrections);
    expect(result).toContain("## Recent User Corrections");
    expect(result).toContain("src/services/my-service.ts");
    expect(result).toContain("abc12345"); // truncated to 8 chars
    expect(result).not.toContain("def67890"); // rest dropped
    expect(result).toContain("feat: add something");
    expect(result).toContain("git commit --amend --no-edit");
    expect(result).toContain("2026-05-15T10:00:00.000Z");
  });

  it("produces an entry for each correction record", () => {
    const corrections: CorrectionRecord[] = [
      {
        agent_type: "engineer",
        commit_sha: "aaa00000",
        commit_subject: "fix: first",
        correction_command: "git commit --amend",
        file_path: "src/a.ts",
        timestamp: "2026-05-15T10:00:00.000Z",
      },
      {
        agent_type: "engineer",
        commit_sha: "bbb11111",
        commit_subject: "fix: second",
        correction_command: "git revert HEAD",
        file_path: "src/b.ts",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ];
    const result = formatCorrectionsSection(corrections);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toContain("fix: first");
    expect(result).toContain("fix: second");
    expect(result).toContain("git revert HEAD");
  });
});
