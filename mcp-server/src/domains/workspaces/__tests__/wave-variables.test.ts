import { describe, expect, it } from "vitest";
import { escapeDollarBrace, parseTaskIdsForWave } from "../wave-variables.ts";

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

// parseTaskIdsForWave — pure parsing helper

describe("parseTaskIdsForWave", () => {
  const indexContent = `## Plan Index

| Task | Wave | Depends on | Files | Principles |
|------|------|------------|-------|------------|
| iwc-01 | 1 | -- | wave-variables.ts | functions-do-one-thing |
| iwc-02 | 1 | -- | gate-runner.ts | validate-at-trust-boundaries |
| iwc-03 | 2 | iwc-01 | board.ts | prefer-immutable-data |
| iwc-04 | 2 | iwc-02 | consultation.ts | handle-partial-failure |
`;

  it("returns task IDs for wave 1", () => {
    expect(parseTaskIdsForWave(indexContent, 1)).toEqual(["iwc-01", "iwc-02"]);
  });

  it("returns task IDs for wave 2", () => {
    expect(parseTaskIdsForWave(indexContent, 2)).toEqual(["iwc-03", "iwc-04"]);
  });

  it("returns empty array when no tasks for that wave", () => {
    expect(parseTaskIdsForWave(indexContent, 99)).toEqual([]);
  });

  it("skips header rows", () => {
    const result = parseTaskIdsForWave(indexContent, 1);
    expect(result).not.toContain("Task");
  });

  it("handles backtick-wrapped task IDs: | `task-01` | 1 |", () => {
    const backtickContent = `## Plan Index

| Task | Wave | Depends on | Files | Principles |
|------|------|------------|-------|------------|
| \`adr004-01\` | 1 | — |  |  |
| \`adr004-02\` | 1 | — |  |  |
| \`adr004-03\` | 2 | adr004-01 |  |  |
`;
    expect(parseTaskIdsForWave(backtickContent, 1)).toEqual(["adr004-01", "adr004-02"]);
    expect(parseTaskIdsForWave(backtickContent, 2)).toEqual(["adr004-03"]);
  });

  it("handles plain (no-backtick) task IDs as regression test", () => {
    const plainContent = `## Plan Index

| Task | Wave | Depends on |
|------|------|------------|
| plain-01 | 1 | — |
| plain-02 | 2 | plain-01 |
`;
    expect(parseTaskIdsForWave(plainContent, 1)).toEqual(["plain-01"]);
    expect(parseTaskIdsForWave(plainContent, 2)).toEqual(["plain-02"]);
  });

  it("skips separator row (--- in table)", () => {
    const contentWithSep = `| Task | Wave |
|------|------|
| real-01 | 1 |
`;
    const result = parseTaskIdsForWave(contentWithSep, 1);
    expect(result).toEqual(["real-01"]);
    expect(result).not.toContain("---");
  });
});
