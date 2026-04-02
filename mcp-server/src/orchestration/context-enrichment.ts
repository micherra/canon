/**
 * Context Enrichment Assembly Module
 *
 * Assembles a ${enrichment} block for agent spawn prompts.
 * Contains four sections:
 *   1. Recent Changes  — git log for files in task scope
 *   2. Drift Signals   — DriftStore reviews for files in scope
 *   3. Prior Work      — sibling workspace artifacts that mention scoped files
 *   4. Tensions        — cross-reference of drift violations + recent commits
 *
 * Follows Canon principles:
 *   - thin-handlers: each section is a separate assembler function
 *   - fail-closed-by-default: every section catches errors and returns empty with warnings
 *   - agent-evidence-over-intuition: each section cites concrete data (SHAs, verdicts, timestamps)
 *   - agent-convergence-discipline: budget caps prevent context overload
 *
 * All agent-sourced text (git output, drift data, workspace content) passes through
 * escapeDollarBrace before inclusion in output.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gitLog } from "../adapters/git-adapter.ts";
import { DriftStore } from "../drift/store.ts";
import { extractSection } from "./inject-context.ts";
import type { Board, ResolvedFlow } from "./flow-schema.ts";
import type { ReviewEntry } from "../schema.ts";
import { resolveTaskScope } from "./scope-resolver.ts";
import { escapeDollarBrace } from "./wave-variables.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnrichmentInput {
  workspace: string;
  stateId: string;
  board: Board;
  flow: ResolvedFlow;
  baseCommit?: string;
  cwd: string;
  projectDir?: string;
}

export interface EnrichmentResult {
  content: string; // The assembled ${enrichment} block, or empty string
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Budget caps by flow tier (number of files to include per section). */
const TIER_FILE_CAPS: Record<string, number> = {
  small: 5,
  medium: 15,
  large: 30,
};

/** Default file cap when tier is not recognized. */
const DEFAULT_FILE_CAP = 15;

/** Maximum total enrichment characters. */
const MAX_ENRICHMENT_CHARS = 6000;

/** Maximum sibling workspaces to include in Prior Work. */
const MAX_WORKSPACE_REFS = 3;

/** Maximum tension entries to emit. */
const MAX_TENSIONS = 3;

// ---------------------------------------------------------------------------
// Internal section result type
// ---------------------------------------------------------------------------

interface SectionResult {
  content: string;
  warnings: string[];
  /** Parsed data for cross-section use (optional). */
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the context enrichment block for a spawned agent.
 *
 * Resolution:
 * 1. Resolve task scope (file paths) via scope-resolver
 * 2. If no files, return empty with warning
 * 3. Determine tier file cap
 * 4. Assemble four sections, tracking remaining budget
 * 5. Concatenate under ## Context Enrichment heading
 * 6. Truncate to MAX_ENRICHMENT_CHARS if needed
 *
 * Never throws.
 */
export async function assembleEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  const warnings: string[] = [];

  // Step 1: resolve task scope
  const allFilePaths = resolveTaskScope({
    workspace: input.workspace,
    stateId: input.stateId,
    board: input.board,
  });

  // Step 2: no scope → empty
  if (allFilePaths.length === 0) {
    return { content: "", warnings: ["enrichment: no task scope found"] };
  }

  // Step 3: determine tier cap
  const tier = (input.flow as { tier?: string }).tier ?? "medium";
  const fileCap = TIER_FILE_CAPS[tier] ?? DEFAULT_FILE_CAP;

  // Step 4: slice to cap
  const filePaths = allFilePaths.slice(0, fileCap);

  // Step 5: assemble sections with shared budget
  // Each section gets budget/4 of the total char budget.
  const sectionBudget = Math.floor(MAX_ENRICHMENT_CHARS / 4);

  const [gitSection, driftSection] = await Promise.all([
    safeAssembleGitSection(filePaths, input.cwd, sectionBudget, warnings),
    safeAssembleDriftSection(filePaths, input.projectDir, sectionBudget, warnings),
  ]);

  const workspaceSection = await safeAssembleWorkspaceSection(filePaths, input.workspace, sectionBudget, warnings);

  const tensionsSection = assembleTensionsSection(
    gitSection.data as Map<string, string[]> | null,
    driftSection.data as ReviewEntry[] | null,
    filePaths,
    sectionBudget,
  );
  warnings.push(...tensionsSection.warnings);

  // Step 6: concatenate non-empty sections
  const sections = [gitSection.content, driftSection.content, workspaceSection.content, tensionsSection.content].filter(
    (s) => s.length > 0,
  );

  if (sections.length === 0) {
    return { content: "", warnings };
  }

  const heading = "## Context Enrichment\n\n";
  let assembled = heading + sections.join("\n\n");

  // Step 7: truncate if needed
  if (assembled.length > MAX_ENRICHMENT_CHARS) {
    assembled = `${assembled.slice(0, MAX_ENRICHMENT_CHARS - 12)}\n[truncated]`;
  }

  return { content: assembled, warnings };
}

// ---------------------------------------------------------------------------
// Section assemblers
// ---------------------------------------------------------------------------

/**
 * Assemble git section, catching all errors.
 * Returns data as Map<filePath, commitLines[]> for cross-section use.
 */
async function safeAssembleGitSection(
  filePaths: string[],
  cwd: string,
  budget: number,
  warnings: string[],
): Promise<SectionResult & { data: Map<string, string[]> | null }> {
  try {
    return assembleGitSection(filePaths, cwd, budget, warnings);
  } catch (err) {
    warnings.push(`enrichment: git section failed — ${String(err)}`);
    return { content: "", warnings: [], data: null };
  }
}

/**
 * Assemble drift section, catching all errors.
 * Returns data as ReviewEntry[] for cross-section use.
 */
async function safeAssembleDriftSection(
  filePaths: string[],
  projectDir: string | undefined,
  budget: number,
  warnings: string[],
): Promise<SectionResult & { data: ReviewEntry[] | null }> {
  try {
    return await assembleDriftSection(filePaths, projectDir, budget);
  } catch (err) {
    warnings.push(`enrichment: drift section failed — ${String(err)}`);
    return { content: "", warnings: [], data: null };
  }
}

/**
 * Assemble workspace section, catching all errors.
 */
async function safeAssembleWorkspaceSection(
  filePaths: string[],
  workspace: string,
  budget: number,
  warnings: string[],
): Promise<SectionResult> {
  try {
    return assembleWorkspaceSection(filePaths, workspace, budget);
  } catch (err) {
    warnings.push(`enrichment: workspace section failed — ${String(err)}`);
    return { content: "", warnings: [] };
  }
}

// ---------------------------------------------------------------------------
// Git section
// ---------------------------------------------------------------------------

/**
 * `assembleGitSection` — Recent Changes.
 *
 * Calls gitLog per file (up to 3 commits) and formats as:
 *   - `file.ts`: "msg1", "msg2", "msg3"
 *
 * Returns data as Map<filePath, commitLines[]> for tensions cross-reference.
 */
function assembleGitSection(
  filePaths: string[],
  cwd: string,
  budget: number,
  outerWarnings: string[],
): SectionResult & { data: Map<string, string[]> | null } {
  const fileCommits = new Map<string, string[]>();
  const warnings: string[] = [];
  const lines: string[] = [];

  for (const filePath of filePaths) {
    const result = gitLog([filePath], 3, cwd);
    if (!result.ok) {
      warnings.push(`enrichment: git log failed for ${filePath}`);
      continue;
    }

    const commitLines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);

    if (commitLines.length === 0) {
      continue;
    }

    // Parse: "<sha> <subject>" — escape the subject
    const subjects = commitLines.map((line) => {
      const spaceIdx = line.indexOf(" ");
      const subject = spaceIdx >= 0 ? line.slice(spaceIdx + 1) : line;
      return escapeDollarBrace(subject.trim());
    });

    fileCommits.set(filePath, subjects);

    const quotedSubjects = subjects.map((s) => `"${s}"`).join(", ");
    lines.push(`- \`${filePath}\`: ${quotedSubjects}`);
  }

  if (lines.length === 0) {
    // All files failed git log — emit a single warning
    if (warnings.length > 0) {
      outerWarnings.push("enrichment: git log failed for all files");
    }
    return { content: "", warnings, data: null };
  }

  outerWarnings.push(...warnings);

  let content = `### Recent Changes\n\n${lines.join("\n")}`;
  if (content.length > budget) {
    content = content.slice(0, budget);
  }

  return { content, warnings: [], data: fileCommits };
}

// ---------------------------------------------------------------------------
// Drift section
// ---------------------------------------------------------------------------

/**
 * `assembleDriftSection` — Drift Signals.
 *
 * Calls DriftStore.getReviewsForFiles and formats as:
 *   - `file.ts`: last verdict CLEAN (2 days ago), N active violations
 */
async function assembleDriftSection(
  filePaths: string[],
  projectDir: string | undefined,
  budget: number,
): Promise<SectionResult & { data: ReviewEntry[] | null }> {
  if (!projectDir) {
    return { content: "", warnings: [], data: null };
  }

  const store = new DriftStore(projectDir);
  const reviews = await store.getReviewsForFiles(filePaths);

  if (reviews.length === 0) {
    return { content: "", warnings: [], data: null };
  }

  const lines: string[] = [];

  for (const filePath of filePaths) {
    // Find the most recent review that includes this file
    const fileReviews = reviews
      .filter((r) => r.files.includes(filePath))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (fileReviews.length === 0) {
      continue;
    }

    const latest = fileReviews[0];
    const relativeTime = formatRelativeTime(latest.timestamp);
    const violationCount = (latest.violations ?? []).filter((v) => v.file_path === filePath || !v.file_path).length;

    const verdictEscaped = escapeDollarBrace(latest.verdict);
    lines.push(
      `- \`${filePath}\`: last verdict ${verdictEscaped} (${relativeTime}), ${violationCount} active violations`,
    );
  }

  if (lines.length === 0) {
    return { content: "", warnings: [], data: null };
  }

  let content = `### Drift Signals\n\n${lines.join("\n")}`;
  if (content.length > budget) {
    content = content.slice(0, budget);
  }

  return { content, warnings: [], data: reviews };
}

// ---------------------------------------------------------------------------
// Workspace section
// ---------------------------------------------------------------------------

/**
 * `assembleWorkspaceSection` — Prior Work.
 *
 * Scans sibling workspace directories (parent of workspace) for DESIGN.md
 * and REVIEW.md files that mention any of the scoped file paths.
 * Caps at MAX_WORKSPACE_REFS references.
 */
function assembleWorkspaceSection(filePaths: string[], workspace: string, budget: number): SectionResult {
  const branchDir = dirname(workspace);

  if (!existsSync(branchDir)) {
    return { content: "", warnings: [] };
  }

  let siblings: string[];
  try {
    siblings = readdirSync(branchDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && join(branchDir, d.name) !== workspace)
      .map((d) => join(branchDir, d.name));
  } catch {
    return { content: "", warnings: [] };
  }

  const entries: string[] = [];

  for (const siblingWs of siblings) {
    if (entries.length >= MAX_WORKSPACE_REFS) {
      break;
    }

    const wsName = basename(siblingWs);
    const matchedContent = findMatchingArtifact(siblingWs, filePaths);

    if (matchedContent === null) {
      continue;
    }

    // Extract a short preview (first 200 chars)
    const preview = escapeDollarBrace(matchedContent.slice(0, 200).replace(/\n/g, " "));
    entries.push(`- **${wsName}**: ${preview}`);
  }

  if (entries.length === 0) {
    return { content: "", warnings: [] };
  }

  let content = `### Prior Work\n\n${entries.join("\n")}`;
  if (content.length > budget) {
    content = content.slice(0, budget);
  }

  return { content, warnings: [] };
}

/**
 * Search a workspace directory for DESIGN.md or REVIEW.md files that
 * mention any of the given file paths. Returns the first matching file's
 * content, or null if none found.
 */
function findMatchingArtifact(wsDir: string, filePaths: string[]): string | null {
  const plansDir = join(wsDir, "plans");
  const reviewsDir = join(wsDir, "reviews");

  // Candidate artifact files to check
  const candidates: string[] = [];

  // Check plans/*/DESIGN.md
  if (existsSync(plansDir)) {
    try {
      const planDirs = readdirSync(plansDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(plansDir, d.name));

      for (const planDir of planDirs) {
        const designFile = join(planDir, "DESIGN.md");
        if (existsSync(designFile)) {
          candidates.push(designFile);
        }
      }
    } catch {
      // Silently skip unreadable directories
    }
  }

  // Check reviews/REVIEW.md
  const reviewFile = join(reviewsDir, "REVIEW.md");
  if (existsSync(reviewFile)) {
    candidates.push(reviewFile);
  }

  for (const candidatePath of candidates) {
    try {
      const content = readFileSync(candidatePath, "utf-8");
      const mentionsFile = filePaths.some((fp) => content.includes(fp));
      if (mentionsFile) {
        return content;
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tensions section
// ---------------------------------------------------------------------------

/**
 * `assembleTensionsSection` — cross-reference drift violations with recent commits.
 *
 * For each file that has BOTH drift violations AND recent commits, emits:
 *   - **`file.ts`**: has N active violations but M recent commits — review drift alignment
 *
 * Caps at MAX_TENSIONS entries.
 */
function assembleTensionsSection(
  fileCommits: Map<string, string[]> | null,
  reviews: ReviewEntry[] | null,
  filePaths: string[],
  budget: number,
): SectionResult {
  if (!fileCommits || !reviews || fileCommits.size === 0 || reviews.length === 0) {
    return { content: "", warnings: [] };
  }

  const entries: string[] = [];

  for (const filePath of filePaths) {
    if (entries.length >= MAX_TENSIONS) {
      break;
    }

    const commits = fileCommits.get(filePath);
    if (!commits || commits.length === 0) {
      continue;
    }

    // Count active violations for this file across all reviews
    const violationCount = countViolationsForFile(reviews, filePath);
    if (violationCount === 0) {
      continue;
    }

    entries.push(
      `- **\`${filePath}\`**: has ${violationCount} active violations but ${commits.length} recent commits — review drift alignment`,
    );
  }

  if (entries.length === 0) {
    return { content: "", warnings: [] };
  }

  let content = `### Tensions\n\n${entries.join("\n")}`;
  if (content.length > budget) {
    content = content.slice(0, budget);
  }

  return { content, warnings: [] };
}

/**
 * Count violations associated with a specific file path across all reviews.
 * Counts violations where file_path matches or where file_path is absent.
 */
function countViolationsForFile(reviews: ReviewEntry[], filePath: string): number {
  let count = 0;
  for (const review of reviews) {
    if (!review.files.includes(filePath)) {
      continue;
    }
    const fileViolations = (review.violations ?? []).filter((v) => v.file_path === filePath || !v.file_path);
    count += fileViolations.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Format a timestamp as a relative time string (e.g., "2 days ago").
 * Falls back to the ISO string if calculation fails.
 */
function formatRelativeTime(timestamp: string): string {
  try {
    const ms = Date.now() - new Date(timestamp).getTime();
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  } catch {
    return timestamp;
  }
}
