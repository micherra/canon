import { describe, it, expect } from "vitest";
import { parseTimeout } from "../tools/get-spawn-prompt.ts";

describe("parseTimeout", () => {
  it("parses minutes", () => {
    expect(parseTimeout("10m")).toBe(600000);
  });

  it("parses seconds", () => {
    expect(parseTimeout("30s")).toBe(30000);
  });

  it("parses hours", () => {
    expect(parseTimeout("1h")).toBe(3600000);
  });

  it("parses compound formats", () => {
    expect(parseTimeout("1h30m")).toBe(5400000);
  });

  it("returns undefined for invalid input", () => {
    expect(parseTimeout("abc")).toBeUndefined();
    expect(parseTimeout("")).toBeUndefined();
    expect(parseTimeout("10x")).toBeUndefined();
  });

  it("returns undefined for partial invalid input", () => {
    expect(parseTimeout("10m garbage")).toBeUndefined();
  });
});
