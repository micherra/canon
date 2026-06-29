/**
 * candidate-injection.test.ts — withInjectedCandidate isolation tests
 *
 * Tests:
 * - Real skills/canon/evals/ hash unchanged before/after a run
 * - Temp dir is removed after the callback
 * - Path-traversal target_path is rejected
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isGuardrailTarget,
  withInjectedCandidate,
  withInjectedGuardrailCandidate,
} from "../services/candidate-injection.ts";

// From __tests__/ → (1) evolution → (2) features → (3) src → (4) mcp-server → (5) worktree
const WORKTREE_ROOT = join(import.meta.dirname ?? __dirname, "../../../../..");

const EVALS_DIR = join(WORKTREE_ROOT, "skills", "canon", "evals");

/**
 * Compute a hash of all files in the given directory (deterministic).
 * Walks files alphabetically for consistency.
 */
async function hashDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? dir, e.name))
    .sort();

  for (const filePath of files) {
    // biome-ignore lint/performance/noAwaitInLoops: deterministic hashing requires sequential, ordered reads
    const content = await readFile(filePath);
    hash.update(filePath.replace(dir, "")); // relative path
    hash.update(content);
  }
  return hash.digest("hex");
}

describe("withInjectedCandidate", () => {
  let evalsHashBefore: string;

  beforeEach(async () => {
    evalsHashBefore = await hashDir(EVALS_DIR);
  });

  afterEach(async () => {
    // Verify the real evals dir is still intact
    const hashAfter = await hashDir(EVALS_DIR);
    expect(hashAfter).toBe(evalsHashBefore);
  });

  it("does not mutate the real skills/canon/evals/ directory", async () => {
    let capturedTmpDir: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      "# modified candidate content",
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        capturedTmpDir = tmpDir;
        // Verify the tmp dir has the modified file
        const content = await readFile(
          join(tmpDir, "skills", "canon", "evals", "eval-set.json"),
          "utf-8",
        );
        expect(content).toBe("# modified candidate content");
      },
    );

    // After the callback, hash of real dir is unchanged (checked in afterEach)
    // Also verify the captured tmpDir was removed
    if (capturedTmpDir) {
      await expect(stat(capturedTmpDir)).rejects.toThrow();
    }
  });

  it("removes the temp dir after the callback completes", async () => {
    let tmpDirPath: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      "some content",
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        tmpDirPath = tmpDir;
        // tmpDir should exist during callback
        const s = await stat(tmpDir);
        expect(s.isDirectory()).toBe(true);
      },
    );

    // tmpDir should be gone after callback
    expect(tmpDirPath).toBeDefined();
    await expect(stat(tmpDirPath!)).rejects.toThrow();
  });

  it("removes the temp dir even when the callback throws", async () => {
    let tmpDirPath: string | undefined;

    await expect(
      withInjectedCandidate(
        WORKTREE_ROOT,
        "some content",
        "skills/canon/evals/eval-set.json",
        async (tmpDir) => {
          tmpDirPath = tmpDir;
          throw new Error("callback error");
        },
      ),
    ).rejects.toThrow("callback error");

    // tmpDir should still be cleaned up
    expect(tmpDirPath).toBeDefined();
    await expect(stat(tmpDirPath!)).rejects.toThrow();
  });

  it("rejects path-traversal target_path", async () => {
    await expect(
      withInjectedCandidate(
        WORKTREE_ROOT,
        "malicious content",
        "../../../etc/passwd",
        async (_tmpDir) => {
          // should not reach here
        },
      ),
    ).rejects.toThrow(/path traversal|outside.*temp|invalid.*path/i);
  });

  it("rejects absolute target_path that escapes the temp root", async () => {
    await expect(
      withInjectedCandidate(WORKTREE_ROOT, "malicious content", "/etc/passwd", async (_tmpDir) => {
        // should not reach here
      }),
    ).rejects.toThrow(/path traversal|outside.*temp|invalid.*path/i);
  });

  it("rejects target_path pointing to run-evals.sh (P1-BUG-2: harness bypass guard)", async () => {
    // A candidate that targets run-evals.sh would overwrite the trusted runner and
    // could print a fake winning summary. Must be rejected before any write.
    await expect(
      withInjectedCandidate(
        WORKTREE_ROOT,
        "#!/bin/bash\necho 'Total: 10 | Passed: 10 | Failed: 0 | Errors: 0 | Skipped: 0'\nexit 0",
        "skills/canon/evals/run-evals.sh",
        async (_tmpDir) => {
          // must not reach here
        },
      ),
    ).rejects.toThrow(/harness|run-evals\.sh|forbidden|reserved/i);
  });

  it("rejects target_path that is just 'run-evals.sh' (relative to evals dir)", async () => {
    // When the caller passes just the filename (relative to evals dir),
    // the harness guard must still reject it.
    await expect(
      withInjectedCandidate(
        WORKTREE_ROOT,
        "#!/bin/bash\nexit 0",
        "run-evals.sh",
        async (_tmpDir) => {
          // must not reach here
        },
      ),
    ).rejects.toThrow(/harness|run-evals\.sh|forbidden|reserved/i);
  });

  it("writes the candidate content to the correct file in the temp tree", async () => {
    const candidateText = '{"skill_name":"canon","evals":[{"id":"injected"}]}';

    await withInjectedCandidate(
      WORKTREE_ROOT,
      candidateText,
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const written = await readFile(
          join(tmpDir, "skills", "canon", "evals", "eval-set.json"),
          "utf-8",
        );
        expect(written).toBe(candidateText);
      },
    );
  });
});

// ── isGuardrailTarget ──────────────────────────────────────────────────────────

describe("isGuardrailTarget", () => {
  it("returns true for rules/x.md (plugin artifact root)", () => {
    expect(isGuardrailTarget("rules/x.md")).toBe(true);
  });

  it("returns false for skills/canon/evals/eval-set.json (eval surface — stays eval-surface mode)", () => {
    expect(isGuardrailTarget("skills/canon/evals/eval-set.json")).toBe(false);
  });

  it("returns false for skills/canon/evals/run-evals.sh (eval surface)", () => {
    expect(isGuardrailTarget("skills/canon/evals/run-evals.sh")).toBe(false);
  });

  it("returns true for primers/y.md (plugin artifact root)", () => {
    expect(isGuardrailTarget("primers/y.md")).toBe(true);
  });

  it("returns true for agents/foo.md", () => {
    expect(isGuardrailTarget("agents/foo.md")).toBe(true);
  });

  it("returns true for skills/canon/SKILL.md (skills root, outside evals/)", () => {
    expect(isGuardrailTarget("skills/canon/SKILL.md")).toBe(true);
  });

  it("returns true for principles/rules/some-rule.md", () => {
    expect(isGuardrailTarget("principles/rules/some-rule.md")).toBe(true);
  });

  it("returns true for templates/prd.md", () => {
    expect(isGuardrailTarget("templates/prd.md")).toBe(true);
  });

  it("returns true for references/some-ref.md", () => {
    expect(isGuardrailTarget("references/some-ref.md")).toBe(true);
  });

  it("returns false for non-plugin-root paths (mcp-server/...)", () => {
    expect(isGuardrailTarget("mcp-server/src/foo.ts")).toBe(false);
  });

  it("returns false for path traversal attempts", () => {
    expect(isGuardrailTarget("../../etc/passwd")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isGuardrailTarget("")).toBe(false);
  });
});

// ── withInjectedGuardrailCandidate ────────────────────────────────────────────

describe("withInjectedGuardrailCandidate", () => {
  const RULES_DIR = join(WORKTREE_ROOT, "rules");

  let rulesHashBefore: string;

  beforeEach(async () => {
    rulesHashBefore = await hashDir(RULES_DIR);
  });

  afterEach(async () => {
    // Real rules/ tree must be byte-unchanged after every guardrail injection.
    const hashAfter = await hashDir(RULES_DIR);
    expect(hashAfter).toBe(rulesHashBefore);
  });

  it("writes the candidate at target_path inside a sandbox containing artifact roots", async () => {
    const candidateText = "# guardrail candidate for injection test";

    await withInjectedGuardrailCandidate(
      WORKTREE_ROOT,
      candidateText,
      "rules/test-guardrail-candidate.md",
      async (tmpDir) => {
        // Candidate must be at the correct location inside the sandbox.
        const written = await readFile(
          join(tmpDir, "rules", "test-guardrail-candidate.md"),
          "utf-8",
        );
        expect(written).toBe(candidateText);

        // The sandbox must contain the rules/ artifact root (copied from project).
        const rulesStat = await stat(join(tmpDir, "rules"));
        expect(rulesStat.isDirectory()).toBe(true);
      },
    );
  });

  it("does not mutate the real rules/ directory (hash snapshot)", async () => {
    await withInjectedGuardrailCandidate(
      WORKTREE_ROOT,
      "# candidate content",
      "rules/test-guardrail-immutability.md",
      async (_tmpDir) => {
        // afterEach verifies the hash.
      },
    );
  });

  it("cleans up the temp dir after the callback completes", async () => {
    let tmpDirPath: string | undefined;

    await withInjectedGuardrailCandidate(
      WORKTREE_ROOT,
      "# test",
      "rules/test-guardrail-cleanup.md",
      async (tmpDir) => {
        tmpDirPath = tmpDir;
        const s = await stat(tmpDir);
        expect(s.isDirectory()).toBe(true);
      },
    );

    expect(tmpDirPath).toBeDefined();
    await expect(stat(tmpDirPath!)).rejects.toThrow();
  });

  it("cleans up the temp dir even when the callback throws", async () => {
    let tmpDirPath: string | undefined;

    await expect(
      withInjectedGuardrailCandidate(
        WORKTREE_ROOT,
        "# test",
        "rules/test-guardrail-throw.md",
        async (tmpDir) => {
          tmpDirPath = tmpDir;
          throw new Error("callback error");
        },
      ),
    ).rejects.toThrow("callback error");

    expect(tmpDirPath).toBeDefined();
    await expect(stat(tmpDirPath!)).rejects.toThrow();
  });

  it("rejects path-traversal target_path (../../etc/passwd)", async () => {
    await expect(
      withInjectedGuardrailCandidate(
        WORKTREE_ROOT,
        "malicious content",
        "../../../etc/passwd",
        async (_tmpDir) => {
          // should not reach here — rejection expected before callback
        },
      ),
    ).rejects.toThrow(/path traversal|outside.*temp|invalid.*path/i);
  });

  it("rejects target_path pointing to run-evals.sh (harness bypass guard)", async () => {
    await expect(
      withInjectedGuardrailCandidate(
        WORKTREE_ROOT,
        "#!/bin/bash\nexit 0",
        "skills/canon/evals/run-evals.sh",
        async (_tmpDir) => {
          // should not reach here — rejection expected before callback
        },
      ),
    ).rejects.toThrow(/harness|run-evals\.sh|forbidden|reserved/i);
  });
});
