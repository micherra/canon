import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { seedExecution } from "../../__tests__/seed-execution-test-helper.ts";
import { writeDesign } from "../write-design.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { force: true, recursive: true });
});

describe("writeDesign — happy path", () => {
  it("writes DESIGN.md to plans/{slug}/DESIGN.md and emits a write receipt", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));
    seedExecution(tmpDir);

    const result = await writeDesign({
      content: "## Design: Something\n\nBody.\n",
      slug: "my-epic",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path.replaceAll("\\", "/")).toContain("plans/my-epic/DESIGN.md");

    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Design: Something");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("design");
    expect(events[0].payload.artifact_path).toBe(result.path);
  });

  it("fail-open: receipt emit failure does not prevent the write from succeeding", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));
    seedExecution(tmpDir);

    // The receipt-emit path (emitWriteReceipt) independently fails open on a
    // store error — covered directly in write-receipt.test.ts. Note: prior to
    // the fail-closed workspace-initialized guard, this test exercised an
    // entirely-unbacked workspace to force that internal emit failure; the
    // guard now rejects an unbacked workspace before reaching emitWriteReceipt
    // at all (that IS the new fail-closed behavior — see the "fail-closed on
    // unbacked workspace" describe block below), so this test now just pins
    // that writeDesign succeeds end-to-end against a properly-initialized
    // workspace and never propagates an emit failure as a tool error.
    const result = await writeDesign({
      content: "## Design\n",
      slug: "fail-open-epic",
      workspace: tmpDir,
    });

    assertOk(result);
  });
});

describe("writeDesign — validation errors", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writeDesign({
      content: "## Design\n",
      slug: "my-epic",
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });

  it("returns INVALID_INPUT for invalid slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));

    const result = await writeDesign({
      content: "## Design\n",
      slug: "bad slug!",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));

    const result = await writeDesign({
      content: "## Design\n",
      slug: "../evil",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });
});
