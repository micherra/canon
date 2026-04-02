/**
 * Postcondition contract checker — evaluates declarative assertions after state completion.
 *
 * Assertions are evaluated deterministically with no LLM involvement.
 * Results are returned as values (passed/failed), never thrown as errors.
 *
 * Security: bash_check commands are validated against a denylist before any shell execution.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitExec } from "../adapters/git-adapter.ts";
import { runShell } from "../adapters/process-adapter.ts";
import type { PostconditionAssertion, PostconditionResult } from "./flow-schema.ts";

const BASH_DENYLIST = ["rm", "sudo", "curl", "wget", "chmod", "chown", "mkfs", "dd"];

/**
 * Resolve postcondition assertions from two sources:
 *   1. Explicit YAML declarations (stateDef.postconditions)
 *   2. Agent-discovered assertions (boardState.discovered_postconditions)
 *
 * Explicit YAML takes priority. If explicit assertions exist, discovered ones are ignored.
 * If no explicit assertions exist, discovered assertions are used.
 */
export function resolvePostconditions(
  explicit?: PostconditionAssertion[],
  discovered?: PostconditionAssertion[],
): PostconditionAssertion[] {
  if (explicit?.length) return explicit;
  if (discovered?.length) {
    // Security: strip bash_check entries from agent-discovered postconditions.
    // Only YAML-committed (explicit) postconditions may execute arbitrary commands.
    const safe = discovered.filter((a) => a.type !== "bash_check");
    if (safe.length > 0) return safe;
  }
  return [];
}

/**
 * Evaluate all postcondition assertions and return results as values.
 * Does not throw — all errors are captured in the result's output field.
 */
export function evaluatePostconditions(
  assertions: PostconditionAssertion[],
  cwd: string,
  baseCommit?: string,
): PostconditionResult[] {
  return assertions.map((a, i) => evaluateOne(a, i, cwd, baseCommit));
}

// ---------------------------------------------------------------------------
// Internal — single assertion evaluation
// ---------------------------------------------------------------------------

function evaluateOne(
  assertion: PostconditionAssertion,
  index: number,
  cwd: string,
  baseCommit?: string,
): PostconditionResult {
  const name = `postcondition-${index}-${assertion.type}`;

  switch (assertion.type) {
    case "file_exists":
      return evaluateFileExists(assertion, name, cwd);

    case "file_changed":
      return evaluateFileChanged(assertion, name, cwd, baseCommit);

    case "pattern_match":
      return evaluatePatternMatch(assertion, name, cwd, false);

    case "no_pattern":
      return evaluatePatternMatch(assertion, name, cwd, true);

    case "bash_check":
      return evaluateBashCheck(assertion, name, cwd);
  }
}

function evaluateFileExists(assertion: PostconditionAssertion, name: string, cwd: string): PostconditionResult {
  const target = assertion.target ?? "";
  const fullPath = resolve(cwd, target);
  const passed = existsSync(fullPath);
  return {
    passed,
    name,
    type: assertion.type,
    output: passed ? `File exists: ${target}` : `File not found: ${target}`,
  };
}

function evaluateFileChanged(
  assertion: PostconditionAssertion,
  name: string,
  cwd: string,
  baseCommit?: string,
): PostconditionResult {
  if (!baseCommit) {
    return {
      passed: false,
      name,
      type: assertion.type,
      output: "No base commit for file_changed check",
    };
  }

  const target = assertion.target ?? "";
  const result = gitExec(["diff", "--name-only", baseCommit, "HEAD", "--", target], cwd);

  if (!result.ok) {
    const errMsg = result.stderr.trim() || "git command failed";
    return {
      passed: false,
      name,
      type: assertion.type,
      output: `git diff failed: ${errMsg}`,
    };
  }

  const output = result.stdout.trim();
  const passed = output.length > 0;
  return {
    passed,
    name,
    type: assertion.type,
    output: passed ? `File changed: ${target}` : `File not changed since ${baseCommit}: ${target}`,
  };
}

function evaluatePatternMatch(
  assertion: PostconditionAssertion,
  name: string,
  cwd: string,
  invert: boolean,
): PostconditionResult {
  const target = assertion.target ?? "";
  const fullPath = resolve(cwd, target);

  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch (err) {
    return failResult(name, assertion.type, `Cannot read file: ${target}`, err);
  }

  const patternStr = assertion.pattern ?? "";
  let regex: RegExp;
  try {
    regex = new RegExp(patternStr);
  } catch (err) {
    return failResult(name, assertion.type, `Invalid regex: ${patternStr}`, err);
  }

  const matched = regex.test(content);
  const passed = invert ? !matched : matched;
  return {
    passed,
    name,
    type: assertion.type,
    output: passed
      ? `Pattern ${invert ? "not found" : "found"} in ${target}`
      : `Pattern ${invert ? "found (should be absent)" : "not found"} in ${target}: ${patternStr}`,
  };
}

function evaluateBashCheck(assertion: PostconditionAssertion, name: string, cwd: string): PostconditionResult {
  const command = assertion.command ?? "";

  // Extract the first token (command name) for denylist check
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  // Handle mkfs.* variants like mkfs.ext4
  const baseToken = firstToken.split(".")[0];

  if (BASH_DENYLIST.includes(baseToken)) {
    return {
      passed: false,
      name,
      type: assertion.type,
      output: `Command blocked by security denylist: ${firstToken}`,
    };
  }

  const result = runShell(command, cwd);
  const output = (result.stdout + result.stderr).trim();

  return {
    passed: result.exitCode === 0,
    name,
    type: assertion.type,
    output,
  };
}

/** Helper to create a failure result with consistent error message formatting. */
function failResult(name: string, type: string, message: string, err: unknown): PostconditionResult {
  const errMsg = err instanceof Error ? err.message : String(err);
  return {
    passed: false,
    name,
    type,
    output: `${message} — ${errMsg}`,
  };
}
