/**
 * Tests for list-active-workspaces.ts (list_active_workspaces tool)
 *
 * Covers:
 * - Returns registered rows (discovery — no pasted path needed)
 * - status_filter narrows to matching rows only
 * - INVALID_INPUT on a bad status_filter value
 * - Empty registry returns { workspaces: [] }
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { listActiveWorkspaces } from "../tools/list-active-workspaces.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    evictDriftDbForScope(dir);
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("listActiveWorkspaces — happy path", () => {
  it("returns an empty list when the registry has no rows", async () => {
    const projectDir = makeTmpDir("list-active-ws-proj-");
    const result = await listActiveWorkspaces({}, projectDir);
    assertOk(result);
    expect(result.workspaces).toEqual([]);
  });

  it("returns registered rows without a pasted path (discovery)", async () => {
    const projectDir = makeTmpDir("list-active-ws-proj-");
    getDriftDb(projectDir)
      .getActiveWorkspaces()
      .register({ slug: "add-auth", workspace_path: "/proj/.canon/workspaces/main/add-auth" });

    const result = await listActiveWorkspaces({}, projectDir);
    assertOk(result);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].slug).toBe("add-auth");
    expect(result.workspaces[0].workspace_path).toBe("/proj/.canon/workspaces/main/add-auth");
    expect(result.workspaces[0].status).toBe("live");
  });

  it("status_filter narrows to matching rows only", async () => {
    const projectDir = makeTmpDir("list-active-ws-proj-");
    const dao = getDriftDb(projectDir).getActiveWorkspaces();
    dao.register({ slug: "a", workspace_path: "/ws/a" });
    dao.register({ slug: "b", workspace_path: "/ws/b" });
    dao.markReaped("/ws/b");

    const live = await listActiveWorkspaces({ status_filter: "live" }, projectDir);
    assertOk(live);
    expect(live.workspaces).toHaveLength(1);
    expect(live.workspaces[0].slug).toBe("a");

    const reaped = await listActiveWorkspaces({ status_filter: "reaped" }, projectDir);
    assertOk(reaped);
    expect(reaped.workspaces).toHaveLength(1);
    expect(reaped.workspaces[0].slug).toBe("b");
  });
});

describe("listActiveWorkspaces — INVALID_INPUT", () => {
  it("rejects a status_filter value outside the closed enum", async () => {
    const projectDir = makeTmpDir("list-active-ws-proj-");
    const result = await listActiveWorkspaces(
      { status_filter: "archived" as unknown as "live" },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
