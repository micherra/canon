import { describe, expect, it } from "vitest";
import { escapeDollarBrace } from "../wave-variables.ts";

// escapeDollarBrace — pure function, no I/O

describe("escapeDollarBrace", () => {
  it("escapes ${foo} to \\${foo}", () => {
    expect(escapeDollarBrace("hello ${foo} world")).toBe("hello \\${foo} world");
  });

  it("escapes multiple occurrences", () => {
    expect(escapeDollarBrace("${a} and ${b}")).toBe("\\${a} and \\${b}");
  });

  it("leaves regular text unchanged", () => {
    expect(escapeDollarBrace("no dollar brace here")).toBe("no dollar brace here");
  });

  it("handles empty string", () => {
    expect(escapeDollarBrace("")).toBe("");
  });

  it("leaves $ without brace unchanged", () => {
    expect(escapeDollarBrace("$100 and $200")).toBe("$100 and $200");
  });

  it("escapes the ${ inside a previously-escaped pattern (no lookbehind guard)", () => {
    // The function replaces ALL `${` occurrences, including ones after `\`.
    // This is by design — the escape is additive, not idempotent.
    // The string `\${x}` contains `${`, so it becomes `\\\${x}`.
    const input = "\\${already_escaped}";
    // `\${` matches the regex, so it becomes `\\${` → i.e. one extra backslash
    expect(escapeDollarBrace(input)).toBe("\\\\${already_escaped}");
  });
});
