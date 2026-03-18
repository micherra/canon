import { describe, it, expect, vi } from "vitest";

// Mock vscode module before importing dashboard-panel
vi.mock("vscode", () => ({
  workspace: { workspaceFolders: undefined },
  Uri: { joinPath: vi.fn() },
  window: { activeTextEditor: undefined },
}));

import { isValidRelativePath, getNonce } from "../dashboard-panel";

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
