import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist adapter mock before module imports
// ---------------------------------------------------------------------------

type GitExecResult = { ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut: boolean };
let gitExecImpl: ((args: string[], cwd: string) => GitExecResult) | null = null;
let lastGitExecArgs: { args: string[]; cwd: string } | null = null;

vi.mock("../adapters/git-adapter.ts", () => ({
  gitExec: (args: string[], cwd: string) => {
    lastGitExecArgs = { args, cwd };
    if (gitExecImpl) return gitExecImpl(args, cwd);
    return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
  },
}));

import { clusterByDirectory, clusterByLayer, getChangedFiles } from "../orchestration/diff-cluster.ts";

beforeEach(() => {
  gitExecImpl = null;
  lastGitExecArgs = null;
});

// ---------------------------------------------------------------------------
// clusterByDirectory
// ---------------------------------------------------------------------------

describe("clusterByDirectory", () => {
  it("groups files by first two path segments", () => {
    const files = [
      "src/api/orders.ts",
      "src/api/users.ts",
      "src/services/auth.ts",
      "src/services/billing.ts",
      "src/services/billing.test.ts",
      "src/ui/Dashboard.tsx",
    ];
    const clusters = clusterByDirectory(files);
    expect(clusters).toHaveLength(3);

    const apiCluster = clusters.find((c) => c.key === "src/api");
    expect(apiCluster?.files).toEqual(["src/api/orders.ts", "src/api/users.ts"]);

    const serviceCluster = clusters.find((c) => c.key === "src/services");
    expect(serviceCluster?.files).toHaveLength(3);

    const uiCluster = clusters.find((c) => c.key === "src/ui");
    expect(uiCluster?.files).toEqual(["src/ui/Dashboard.tsx"]);
  });

  it("sorts clusters by file count descending", () => {
    const files = ["src/api/a.ts", "src/services/a.ts", "src/services/b.ts", "src/services/c.ts"];
    const clusters = clusterByDirectory(files);
    expect(clusters[0].key).toBe("src/services");
    expect(clusters[1].key).toBe("src/api");
  });

  it("handles single-segment directories", () => {
    const files = ["package.json", "README.md"];
    const clusters = clusterByDirectory(files);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe(".");
  });

  it("returns empty for empty input", () => {
    expect(clusterByDirectory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clusterByLayer
// ---------------------------------------------------------------------------

describe("clusterByLayer", () => {
  it("groups files by Canon layer", () => {
    const files = [
      "src/routes/users.ts",
      "src/controllers/auth.ts",
      "src/components/Button.tsx",
      "src/services/billing.ts",
      "src/db/migrations/001.sql",
    ];
    const clusters = clusterByLayer(files);

    const apiCluster = clusters.find((c) => c.key === "api");
    expect(apiCluster?.files).toEqual(["src/routes/users.ts", "src/controllers/auth.ts"]);

    const uiCluster = clusters.find((c) => c.key === "ui");
    expect(uiCluster?.files).toEqual(["src/components/Button.tsx"]);

    const domainCluster = clusters.find((c) => c.key === "domain");
    expect(domainCluster?.files).toEqual(["src/services/billing.ts"]);
  });

  it("puts unrecognized files in unknown", () => {
    const files = ["foo/bar/baz.ts"];
    const clusters = clusterByLayer(files);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe("unknown");
  });

  it("returns empty for empty input", () => {
    expect(clusterByLayer([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getChangedFiles — via git-adapter
// ---------------------------------------------------------------------------

describe("getChangedFiles — happy path via git adapter", () => {
  it("returns list of changed files on success", () => {
    gitExecImpl = () => ({
      ok: true,
      stdout: "src/api/users.ts\nsrc/services/auth.ts\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const result = getChangedFiles("abc1234");
    expect(result).toEqual(["src/api/users.ts", "src/services/auth.ts"]);
  });

  it("returns empty array when no files changed (empty stdout)", () => {
    gitExecImpl = () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const result = getChangedFiles("abc1234");
    expect(result).toEqual([]);
  });

  it("passes optional cwd to gitExec", () => {
    gitExecImpl = () => ({ ok: true, stdout: "file.ts\n", stderr: "", exitCode: 0, timedOut: false });
    getChangedFiles("abc1234", "/my/project");
    expect(lastGitExecArgs?.cwd).toBe("/my/project");
  });

  it("passes baseCommit..HEAD in args to gitExec", () => {
    gitExecImpl = () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
    getChangedFiles("abc1234");
    expect(lastGitExecArgs?.args).toContain("abc1234..HEAD");
  });
});

describe("getChangedFiles — graceful degradation on failure", () => {
  it("returns empty array when gitExec returns ok: false (non-zero exit)", () => {
    gitExecImpl = () => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
    });
    const result = getChangedFiles("abc1234");
    expect(result).toEqual([]);
  });

  it("returns empty array when adapter returns timedOut: true (Risk 9)", () => {
    // Risk 9: adapter returns timedOut: true → getChangedFiles degrades gracefully
    gitExecImpl = () => ({ ok: false, stdout: "", stderr: "", exitCode: 1, timedOut: true });
    const result = getChangedFiles("abc1234");
    expect(result).toEqual([]);
  });
});

describe("getChangedFiles — input validation (security)", () => {
  it("returns empty array for invalid base_commit (shell injection attempt)", () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for invalid commit");
    };
    expect(getChangedFiles("abc123; rm -rf /")).toEqual([]);
  });

  it("returns empty array for too-short commit hash", () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for too-short hash");
    };
    expect(getChangedFiles("abc12")).toEqual([]);
  });

  it("returns empty array for empty commit hash", () => {
    gitExecImpl = () => {
      throw new Error("gitExec must NOT be called for empty hash");
    };
    expect(getChangedFiles("")).toEqual([]);
  });
});
