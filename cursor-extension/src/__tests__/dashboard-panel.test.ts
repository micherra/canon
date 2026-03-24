import { describe, it, expect, vi } from "vitest";

// Mock vscode module before importing dashboard-panel
vi.mock("vscode", () => ({
  workspace: { workspaceFolders: undefined },
  Uri: { joinPath: vi.fn() },
  window: { activeTextEditor: undefined },
}));

import { isValidRelativePath, getNonce } from "../dashboard-panel";
import type { ExtensionPushMessage } from "../messages";

describe("isValidRelativePath", () => {
  const root = "/workspace/project";

  it("rejects paths starting with ..", () => {
    expect(isValidRelativePath("../etc/passwd", root)).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isValidRelativePath("/etc/passwd", root)).toBe(false);
  });

  it("rejects empty paths", () => {
    expect(isValidRelativePath("", root)).toBe(false);
  });

  it("accepts valid relative paths", () => {
    expect(isValidRelativePath("src/foo.ts", root)).toBe(true);
  });

  it("accepts nested relative paths", () => {
    expect(isValidRelativePath("src/components/Button.tsx", root)).toBe(true);
  });

  it("rejects paths that resolve outside workspace", () => {
    expect(isValidRelativePath("foo/../../outside", root)).toBe(false);
  });

  it("accepts path at workspace root level", () => {
    expect(isValidRelativePath("file.ts", root)).toBe(true);
  });
});

describe("getNonce", () => {
  it("returns a 32-character string", () => {
    const nonce = getNonce();
    expect(nonce).toHaveLength(32);
  });

  it("contains only alphanumeric characters", () => {
    const nonce = getNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("produces different values on consecutive calls", () => {
    const a = getNonce();
    const b = getNonce();
    expect(a).not.toBe(b);
  });
});

// ── Message protocol type-level tests ──
// These verify that the ExtensionPushMessage union includes the expected shapes.
// TypeScript's assignability rules catch protocol drift at compile time.

describe("ExtensionPushMessage protocol", () => {
  it("accepts a generationProgress message", () => {
    // If this assignment compiles, the type is present in the union
    const msg: ExtensionPushMessage = { type: "generationProgress", elapsed: 42 };
    expect(msg.type).toBe("generationProgress");
    expect((msg as { type: string; elapsed: number }).elapsed).toBe(42);
  });

  it("accepts elapsed value of 0", () => {
    const msg: ExtensionPushMessage = { type: "generationProgress", elapsed: 0 };
    expect((msg as { type: string; elapsed: number }).elapsed).toBe(0);
  });

  it("accepts a graphStatus error message", () => {
    // Verifies the error status (posted when plugin dir is missing) is in the union
    const msg: ExtensionPushMessage = { type: "graphStatus", status: "error" };
    expect(msg.type).toBe("graphStatus");
  });
});
