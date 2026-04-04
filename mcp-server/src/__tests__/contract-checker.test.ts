import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluatePostconditions,
  resolvePostconditions,
} from "../orchestration/contract-checker.ts";
import type { PostconditionAssertion } from "../orchestration/flow-schema.ts";

describe("resolvePostconditions", () => {
  it("returns explicit assertions when both provided", () => {
    const explicit: PostconditionAssertion[] = [{ target: "foo.ts", type: "file_exists" }];
    const discovered: PostconditionAssertion[] = [{ target: "bar.ts", type: "file_exists" }];
    const result = resolvePostconditions(explicit, discovered);
    expect(result).toEqual(explicit);
  });

  it("returns discovered when no explicit assertions", () => {
    const discovered: PostconditionAssertion[] = [{ target: "bar.ts", type: "file_exists" }];
    const result = resolvePostconditions(undefined, discovered);
    expect(result).toEqual(discovered);
  });

  it("returns empty array when neither provided", () => {
    expect(resolvePostconditions()).toEqual([]);
    expect(resolvePostconditions(undefined, undefined)).toEqual([]);
    expect(resolvePostconditions([], [])).toEqual([]);
  });

  it("returns discovered when explicit is empty array", () => {
    const discovered: PostconditionAssertion[] = [{ target: "bar.ts", type: "file_exists" }];
    const result = resolvePostconditions([], discovered);
    expect(result).toEqual(discovered);
  });

  it("returns empty when explicit is empty and discovered is empty", () => {
    expect(resolvePostconditions([], [])).toEqual([]);
  });

  it("strips bash_check entries from discovered postconditions", () => {
    const discovered: PostconditionAssertion[] = [
      { target: "foo.ts", type: "file_exists" },
      { command: "echo injected", type: "bash_check" },
      { pattern: "hello", target: "bar.ts", type: "pattern_match" },
      { command: "npm test", type: "bash_check" },
    ];
    const result = resolvePostconditions(undefined, discovered);
    // bash_check entries must be stripped — only safe types remain
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.type !== "bash_check")).toBe(true);
    expect(result[0]).toEqual({ target: "foo.ts", type: "file_exists" });
    expect(result[1]).toEqual({ pattern: "hello", target: "bar.ts", type: "pattern_match" });
  });

  it("returns empty array when discovered contains only bash_check entries", () => {
    const discovered: PostconditionAssertion[] = [
      { command: "npm test", type: "bash_check" },
      { command: "echo hello", type: "bash_check" },
    ];
    const result = resolvePostconditions(undefined, discovered);
    expect(result).toEqual([]);
  });

  it("does NOT strip bash_check from explicit (YAML-committed) postconditions", () => {
    const explicit: PostconditionAssertion[] = [
      { command: "npm test", type: "bash_check" },
      { target: "foo.ts", type: "file_exists" },
    ];
    const result = resolvePostconditions(explicit, undefined);
    // Explicit YAML entries pass through unchanged — bash_check in YAML is allowed
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("bash_check");
  });
});

describe("evaluatePostconditions — file_exists", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-checker-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("passes when file exists", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const x = 1;");
    const assertions: PostconditionAssertion[] = [{ target: "target.ts", type: "file_exists" }];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("postcondition-0-file_exists");
    expect(results[0].type).toBe("file_exists");
  });

  it("fails when file does not exist", () => {
    const assertions: PostconditionAssertion[] = [{ target: "missing.ts", type: "file_exists" }];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].name).toBe("postcondition-0-file_exists");
  });

  it("returns empty results for empty assertions array", () => {
    const results = evaluatePostconditions([], tmpDir);
    expect(results).toHaveLength(0);
  });
});

describe("evaluatePostconditions — file_changed", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-checker-git-test-"));
    // Initialize git repo with an initial commit
    execSync("git init", { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });
    await writeFile(join(tmpDir, "initial.ts"), "export const x = 1;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "initial"', { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("passes when file has changed since base commit", async () => {
    const baseCommit = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim();
    // Modify a file and commit
    await writeFile(join(tmpDir, "initial.ts"), "export const x = 2;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "change"', { cwd: tmpDir });

    const assertions: PostconditionAssertion[] = [{ target: "initial.ts", type: "file_changed" }];
    const results = evaluatePostconditions(assertions, tmpDir, baseCommit);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("postcondition-0-file_changed");
  });

  it("fails when file has NOT changed since base commit", async () => {
    const baseCommit = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim();
    // Make a different file change
    await writeFile(join(tmpDir, "other.ts"), "export const y = 2;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "other change"', { cwd: tmpDir });

    const assertions: PostconditionAssertion[] = [{ target: "initial.ts", type: "file_changed" }];
    const results = evaluatePostconditions(assertions, tmpDir, baseCommit);
    expect(results[0].passed).toBe(false);
  });

  it("fails with descriptive error when no baseCommit provided", () => {
    const assertions: PostconditionAssertion[] = [{ target: "initial.ts", type: "file_changed" }];
    const results = evaluatePostconditions(assertions, tmpDir, undefined);
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/No base commit/);
  });
});

describe("evaluatePostconditions — pattern_match", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-checker-pattern-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("passes when pattern matches file content", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const greeting = 'hello world';");
    const assertions: PostconditionAssertion[] = [
      { pattern: "hello", target: "target.ts", type: "pattern_match" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(true);
  });

  it("fails when pattern does not match", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const x = 1;");
    const assertions: PostconditionAssertion[] = [
      { pattern: "goodbye", target: "target.ts", type: "pattern_match" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
  });

  it("fails with error message for invalid regex", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const x = 1;");
    const assertions: PostconditionAssertion[] = [
      { pattern: "[invalid", target: "target.ts", type: "pattern_match" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toBeTruthy();
  });

  it("fails when file does not exist", () => {
    const assertions: PostconditionAssertion[] = [
      { pattern: "hello", target: "missing.ts", type: "pattern_match" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
  });
});

describe("evaluatePostconditions — no_pattern", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-checker-no-pattern-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("passes when pattern is NOT found in file", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const x = 1;");
    const assertions: PostconditionAssertion[] = [
      { pattern: "TODO", target: "target.ts", type: "no_pattern" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("postcondition-0-no_pattern");
  });

  it("fails when pattern IS found in file", async () => {
    await writeFile(join(tmpDir, "target.ts"), "// TODO: remove this");
    const assertions: PostconditionAssertion[] = [
      { pattern: "TODO", target: "target.ts", type: "no_pattern" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
  });

  it("fails with error for invalid regex", async () => {
    await writeFile(join(tmpDir, "target.ts"), "export const x = 1;");
    const assertions: PostconditionAssertion[] = [
      { pattern: "[invalid", target: "target.ts", type: "no_pattern" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
  });

  it("fails when file does not exist", () => {
    const assertions: PostconditionAssertion[] = [
      { pattern: "TODO", target: "missing.ts", type: "no_pattern" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].passed).toBe(false);
  });
});

describe("evaluatePostconditions — bash_check", () => {
  it("passes when command exits with code 0", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "echo hello", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("postcondition-0-bash_check");
  });

  it("fails when command exits with non-zero code", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "false", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
  });

  it("blocks 'rm' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "rm -rf /", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'sudo' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "sudo something", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'curl' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "curl http://example.com", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'wget' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "wget http://example.com", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'chmod' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "chmod 777 file", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'chown' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "chown root file", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'mkfs' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "mkfs.ext4 /dev/sda", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("blocks 'dd' command via denylist", () => {
    const assertions: PostconditionAssertion[] = [
      { command: "dd if=/dev/zero of=/dev/sda", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toMatch(/denylist/i);
  });

  it("does not block commands that merely contain denylist words as substrings", () => {
    // "echo rm-something" — first token is "echo", not "rm"
    const assertions: PostconditionAssertion[] = [
      { command: "echo rm-something", target: "", type: "bash_check" },
    ];
    const results = evaluatePostconditions(assertions, process.cwd());
    expect(results[0].passed).toBe(true);
  });
});

describe("evaluatePostconditions — result naming", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-checker-name-test-"));
    await writeFile(join(tmpDir, "a.ts"), "a");
    await writeFile(join(tmpDir, "b.ts"), "b");
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("names results with correct index and type", () => {
    const assertions: PostconditionAssertion[] = [
      { target: "a.ts", type: "file_exists" },
      { target: "b.ts", type: "file_exists" },
      { target: "missing.ts", type: "file_exists" },
    ];
    const results = evaluatePostconditions(assertions, tmpDir);
    expect(results[0].name).toBe("postcondition-0-file_exists");
    expect(results[1].name).toBe("postcondition-1-file_exists");
    expect(results[2].name).toBe("postcondition-2-file_exists");
    expect(results[0].type).toBe("file_exists");
  });
});
