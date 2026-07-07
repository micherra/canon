/**
 * cliff-transcript-source — session-scoped resolver for a cliffed step's
 * Claude Code subagent transcript source file.
 *
 * A cliffed (started/planned) step never carries an `agent_id` anywhere in
 * durable state (see PROBE-FINDINGS.md Probe 0), so the existing
 * `captureTranscript` agent_id glob fallback cannot locate its source. This
 * module resolves the source via the `{agent_type}-{step_id}-{job_suffix}`
 * spawn-name convention (PROBE-FINDINGS.md Probe 1) that Claude Code embeds
 * in each subagent's JSONL filename, scoped to the orchestrator's
 * `session_id` to avoid the wrong-attribution hazard measured in Probe 2
 * (10-38 cross-session candidates when unscoped).
 *
 * Pure-shaped query: filesystem reads only, no writes, no captureTranscript
 * call (that effect lives in cliff-transcript-capture.ts). Fail-open by
 * construction — every branch returns a typed result, no throw escapes.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Typed reasons a transcript source could not be resolved or captured. */
export type CliffCaptureAbsentReason =
  | "no_project_dir"
  | "no_session_id"
  | "projects_dir_unreadable"
  | "no_source_match"
  | "capture_failed";

/** Result of resolving a cliffed step's transcript source file. */
export type CliffTranscriptSourceResult =
  | { path: string }
  | { path: null; reason: Exclude<CliffCaptureAbsentReason, "capture_failed" | "no_project_dir"> };

export type ResolveCliffTranscriptSourceInput = {
  projectDir: string;
  sessionId?: string;
  agentType: string | null;
  stepId: string;
  startedAt?: string;
};

/** Injectable seam for tests — defaults to process.env.HOME (mirrors captureTranscript). */
export type ResolveDeps = { homeDir?: string };

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pick the best candidate among same-step re-spawn files: the one whose
 * birthtimeMs (fallback mtimeMs when birthtime is unsupported/zero) is
 * closest to a parseable `startedAt`; otherwise the newest by mtimeMs.
 */
function pickBestCandidate(dir: string, candidates: string[], startedAt?: string): string {
  const parsedStarted = startedAt ? Date.parse(startedAt) : Number.NaN;
  const useProximity = !Number.isNaN(parsedStarted);

  let best = candidates[0];
  let bestMetric = useProximity ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;

  for (const file of candidates) {
    const stat = statSync(join(dir, file));
    const birthtime = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    if (useProximity) {
      const diff = Math.abs(birthtime - parsedStarted);
      if (diff < bestMetric) {
        bestMetric = diff;
        best = file;
      }
    } else if (stat.mtimeMs > bestMetric) {
      bestMetric = stat.mtimeMs;
      best = file;
    }
  }

  return best;
}

/**
 * Resolve the source JSONL for a cliffed step, or a typed absent-reason.
 *
 * Requires `sessionId` — absent session identity never triggers a
 * cross-session guess (Probe 2). Fail-open: any unexpected filesystem error
 * (unreadable projects dir, etc.) is caught and mapped to
 * `"projects_dir_unreadable"` rather than propagating.
 */
export function resolveCliffTranscriptSource(
  input: ResolveCliffTranscriptSourceInput,
  deps?: ResolveDeps,
): CliffTranscriptSourceResult {
  const { projectDir, sessionId, agentType, stepId, startedAt } = input;

  if (!sessionId) {
    return { path: null, reason: "no_session_id" };
  }

  try {
    const homeDir = deps?.homeDir ?? process.env.HOME ?? "/tmp";
    const projectsDir = join(homeDir, ".claude", "projects", projectDir.replace(/\//g, "-"));
    const subagentsDir = join(projectsDir, sessionId, "subagents");

    const shortType = (agentType ?? "").replace(/^canon:/, "");
    if (!shortType) {
      return { path: null, reason: "no_source_match" };
    }

    const files = readdirSync(subagentsDir);

    // Anchored match: token, then exactly {job_suffix}-{hash}.jsonl — the
    // trailing-dash-plus-exactly-one-more-segment requirement is what
    // actually excludes a longer sibling step_id (e.g. "context-sync"
    // resolving must not match a "context-sync-codex-fix" file, whose
    // remainder after the token contains extra dash-separated segments).
    const tokenPattern = new RegExp(
      `${escapeRegExp(shortType)}-${escapeRegExp(stepId)}-[^-]+-[^-]+\\.jsonl$`,
    );
    const candidates = files.filter((f) => f.endsWith(".jsonl") && tokenPattern.test(f));

    if (candidates.length === 0) {
      return { path: null, reason: "no_source_match" };
    }

    const chosen = pickBestCandidate(subagentsDir, candidates, startedAt);
    return { path: join(subagentsDir, chosen) };
  } catch {
    return { path: null, reason: "projects_dir_unreadable" };
  }
}
