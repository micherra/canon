/**
 * digest-writer — best-effort build digest writer for finalizeWorkspace.
 *
 * After a build completes, this service writes a structured memory file to
 * Claude Code's auto-memory directory so that Auto Dream can consolidate
 * build patterns over time.
 *
 * Public entry point: tryWriteBuildDigest(workspace)
 *   — mirrors tryReleaseClaims / tryAppendAnalytics / tryRunJanitor
 *   — best-effort: wraps everything in try/catch, returns false on failure
 *   — never throws
 *
 * Design decisions:
 *  - DigestData is a local type (not history-types.ts) — orchestration concern
 *  - Cross-feature import from history/services/run-summary-extractors.ts is
 *    justified by the precedent in orchestration-journal.ts importing from
 *    history/services/archive-service.ts (see decision digest-01)
 *  - Auto-memory path derived from CANON_PROJECT_DIR (via server-state.ts projectDir)
 *  - atomicWriteFile used for all writes (same filesystem = atomic rename)
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  parsePlanningBrief,
  parseReviewFile,
} from "@features/history/services/run-summary-extractors.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";

// ---- Local types ----

type DigestData = {
  slug: string;
  date: string; // ISO date: YYYY-MM-DD
  branch: string;
  totalDurationMs: number | null;
  totalSteps: number;
  stepsCompleted: number;
  stepsSkipped: number;
  fixIterations: number;
  reviewVerdict: string | null;
  violationCount: number;
  effortEstimate: string;
  valueEstimate: string;
  outcome: string;
};

// ---- Minimal journal types (local — avoids importing the full orchestration journal) ----

type JournalStep = {
  agent_type?: string | null;
  artifacts_expected?: string[];
  completed_at?: string;
  outcome?: { fix_iterations?: number; review_verdict?: string };
  skip_reason?: string;
  started_at?: string;
  status: string;
  step_id: string;
};

type Journal = {
  steps: JournalStep[];
  version: number;
  workspace: string;
};

// ---- Path resolution ----

/**
 * Convert an absolute project directory path to Claude Code's dashed format
 * and construct the auto-memory directory path.
 *
 * Example: /Users/foo/bar → ~/.claude/projects/-Users-foo-bar/memory/
 *
 * Returns null if projectDir is empty or the resulting directory does not exist.
 */
export function resolveAutoMemoryDir(projectPath: string): string | null {
  if (!projectPath) return null;

  // Replace leading / with - and all remaining / with -
  // "/Users/foo/bar" → "-Users-foo-bar"
  const dashedPath = projectPath.replace(/\//g, "-");

  const memDir = join(homedir(), ".claude", "projects", dashedPath, "memory");

  if (!existsSync(memDir)) return null;

  return memDir;
}

// ---- Journal helpers ----

/** Read and parse journal steps from the workspace directory. */
function readJournalSteps(workspace: string): JournalStep[] {
  const journalPath = join(workspace, "journal.json");
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf-8");
  const parsed = JSON.parse(raw) as Journal;
  return Array.isArray(parsed.steps) ? parsed.steps : [];
}

/** Extract session-derived fields (slug, branch) from the execution store. */
function readSessionFields(workspace: string): { slug: string; branch: string } {
  const session = getExecutionStore(workspace).getSession();
  return {
    branch: session?.branch ?? "",
    slug: session?.slug ?? basename(workspace),
  };
}

/** Read planning brief fields (effort, value, outcome) for the given workspace and slug. */
function readPlanningBriefFields(
  workspace: string,
  slug: string,
): { effortEstimate: string; valueEstimate: string; outcome: string } {
  const planningBriefPath = join(workspace, "plans", slug, "planning-brief.md");
  if (!existsSync(planningBriefPath)) {
    return { effortEstimate: "", outcome: "", valueEstimate: "" };
  }
  const briefContent = readFileSync(planningBriefPath, "utf-8");
  const parsed = parsePlanningBrief(briefContent);
  return {
    effortEstimate: parsed.effortEstimate,
    outcome: parsed.outcome,
    valueEstimate: parsed.valueEstimate,
  };
}

/** Count violations across all review files in the workspace reviews directory. */
function countReviewViolations(workspace: string): number {
  const reviewsDir = join(workspace, "reviews");
  if (!existsSync(reviewsDir)) return 0;
  let count = 0;
  const reviewFiles = globSync("*.md", { cwd: reviewsDir });
  for (const reviewFile of reviewFiles) {
    const reviewContent = readFileSync(join(reviewsDir, reviewFile), "utf-8");
    const reviewResult = parseReviewFile(reviewContent);
    if (reviewResult) {
      count += reviewResult.violations.length;
    }
  }
  return count;
}

// ---- Data extraction ----

/**
 * Extract DigestData from a workspace directory.
 *
 * Reads journal.json, planning-brief.md, and reviews/*.md.
 * Uses readFileSync (best-effort helper context, not a tool handler).
 * Returns defaults when files are missing.
 */
export function extractDigestData(workspace: string): DigestData {
  const steps = readJournalSteps(workspace);
  const { slug, branch } = readSessionFields(workspace);

  // Compute flow outcome from journal steps
  const stepsCompleted = steps.filter((s) => s.status === "completed").length;
  const stepsSkipped = steps.filter((s) => s.status === "skipped").length;
  const totalSteps = steps.length;
  const fixIterations = steps.reduce((sum, s) => sum + (s.outcome?.fix_iterations ?? 0), 0);

  let reviewVerdict: string | null = null;
  for (const s of steps) {
    if (s.outcome?.review_verdict) reviewVerdict = s.outcome.review_verdict;
  }

  const totalDurationMs = computeTotalDurationMs(steps);
  const date = new Date().toISOString().slice(0, 10);
  const { effortEstimate, valueEstimate, outcome } = readPlanningBriefFields(workspace, slug);
  const violationCount = countReviewViolations(workspace);

  return {
    branch,
    date,
    effortEstimate,
    fixIterations,
    outcome,
    reviewVerdict,
    slug,
    stepsCompleted,
    stepsSkipped,
    totalDurationMs,
    totalSteps,
    valueEstimate,
    violationCount,
  };
}

/** Wall clock: max(completed_at) − min(started_at). Null when no timestamps. */
function computeTotalDurationMs(steps: readonly JournalStep[]): number | null {
  const starts = steps.map((s) => s.started_at).filter((t): t is string => typeof t === "string");
  const ends = steps.map((s) => s.completed_at).filter((t): t is string => typeof t === "string");
  if (starts.length === 0 || ends.length === 0) return null;
  const minStart = Math.min(...starts.map((s) => Date.parse(s)));
  const maxEnd = Math.max(...ends.map((s) => Date.parse(s)));
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
  return maxEnd - minStart;
}

// ---- Formatting ----

/** Format milliseconds as human-readable: "Xm Ys" or "Xh Ym". */
function formatDuration(ms: number | null): string {
  if (ms === null) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Format DigestData as a Claude Code auto-memory markdown file.
 *
 * Output has YAML frontmatter with name, description, metadata.type = project,
 * followed by structured markdown sections.
 */
export function formatDigestMarkdown(data: DigestData): string {
  const duration = formatDuration(data.totalDurationMs);
  const verdict = data.reviewVerdict ?? "none";
  const name = `build-digest-${data.date}-${data.slug}`;
  const description = `Build digest for ${data.slug}: ${verdict}, ${duration}`;

  return `---
name: ${name}
description: "${description}"
metadata:
  type: project
---

## Build: ${data.slug}

**Branch**: ${data.branch}
**Date**: ${data.date}
**Duration**: ${duration}

### Planner Estimates vs Actuals

| Metric | Estimate | Actual |
|--------|----------|--------|
| Effort | ${data.effortEstimate || "--"} | ${duration} |
| Value | ${data.valueEstimate || "--"} | -- |
| Outcome | ${data.outcome || "--"} | ${verdict} |

### Build Metrics

- **Total steps**: ${data.totalSteps} (${data.stepsCompleted} completed, ${data.stepsSkipped} skipped)
- **Fix iterations**: ${data.fixIterations}
- **Review verdict**: ${verdict}
- **Violations found**: ${data.violationCount}
`;
}

/**
 * Format a one-line MEMORY.md index entry under 150 characters.
 *
 * Format: - [build-digest-{date}-{slug}.md](build-digest-{date}-{slug}.md) -- {slug}: {verdict}, {duration}
 *
 * Truncates only the summary tail so the markdown link is never broken.
 */
export function formatMemoryIndexEntry(data: DigestData): string {
  const duration = formatDuration(data.totalDurationMs);
  const verdict = data.reviewVerdict ?? "none";
  const fileName = `build-digest-${data.date}-${data.slug}.md`;
  const link = `- [${fileName}](${fileName})`;
  const summary = ` -- ${data.slug}: ${verdict}, ${duration}`;

  const entry = link + summary;
  if (entry.length <= 150) return entry;

  // Truncate only the summary portion so the markdown link remains intact.
  const maxSummaryLen = 150 - link.length - 3; // 3 for "..."
  return `${link + summary.slice(0, maxSummaryLen)}...`;
}

// ---- Public entry point ----

/**
 * Best-effort build digest writer. Called from finalizeWorkspace inside the
 * `if (complete)` block alongside tryReleaseClaims / tryAppendAnalytics.
 *
 * Returns true when digest was written successfully. Returns false on any
 * error — including missing auto-memory dir, malformed workspace data, or
 * filesystem write failures. Never throws.
 */
export async function tryWriteBuildDigest(workspace: string, projectDir: string): Promise<boolean> {
  try {
    // 1. Extract digest data from workspace
    const data = extractDigestData(workspace);

    // 2. Resolve auto-memory directory
    const memDir = resolveAutoMemoryDir(projectDir);
    if (!memDir) {
      console.warn(
        "[canon] finalizeWorkspace: digest write failed: auto-memory directory not found for",
        projectDir,
      );
      return false;
    }

    // 3. Format and write digest file
    const digestContent = formatDigestMarkdown(data);
    const digestFileName = `build-digest-${data.date}-${data.slug}.md`;
    const digestFilePath = join(memDir, digestFileName);
    await atomicWriteFile(digestFilePath, digestContent);

    // 4. Read existing MEMORY.md (or create if missing)
    const memoryMdPath = join(memDir, "MEMORY.md");
    let memoryContent = "";
    if (existsSync(memoryMdPath)) {
      memoryContent = readFileSync(memoryMdPath, "utf-8");
    }

    // 5. Append new entry to MEMORY.md (skip if already present — idempotent on re-runs)
    const indexEntry = formatMemoryIndexEntry(data);
    if (!memoryContent.includes(`(${digestFileName})`)) {
      const updatedContent = memoryContent.endsWith("\n")
        ? `${memoryContent}${indexEntry}\n`
        : `${memoryContent}\n${indexEntry}\n`;
      await atomicWriteFile(memoryMdPath, updatedContent);
    } else {
      // Digest entry already present — overwrite the digest file but skip MEMORY.md append.
      // This handles same-day re-runs where the slug hasn't changed.
    }

    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: digest write failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
