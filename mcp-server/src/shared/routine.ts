import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR } from "./constants.ts";
import { splitFrontmatter } from "./lib/frontmatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Routine = {
  /** Unique kebab-case identifier (peer of a principle id). */
  name: string;
  title: string;
  status: "enabled" | "disabled" | "draft";
  trigger: {
    kind: "schedule" | "github-event" | "api";
    cron?: string;
    event?: string;
  };
  needs: {
    state: "git-native" | "local-canon";
    daemon: boolean;
  };
  /** Optional override; normally Canon-resolved from `needs`. */
  binding_target?: "cloud-routine" | "desktop-task";
  repos: string[];
  scope: "repo" | "account";
  guardrails: {
    /** ALWAYS false; CI-linted (adaptive-queen invariant). */
    mutates_running_build: boolean;
    repo_writes: "notify-only" | "draft-pr" | "none";
    consent: "opt-in" | "tier-gated";
  };
  recurrence: "standing" | "one-shot";
  body: string;
  source: "project" | "plugin";
  filePath: string;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a routine file's raw content into a Routine.
 *
 * Returns `name: ""` for malformed/unparseable files so the loader can filter
 * them out — mirrors `parsePrinciple` returning an empty-id principle on
 * failure. Never throws for expected error conditions (errors-are-values).
 */
export function parseRoutine(raw: string, filePath: string, source: "project" | "plugin"): Routine {
  try {
    const { data: fm, body } = splitFrontmatter(raw);
    const name = (fm.name as string) || "";
    if (!name) return makeEmptyRoutine(filePath, source);
    // Charset constraint — name is a closed identifier domain (mirrors kg-language-overlay id
    // validation). Allows only lowercase alphanumeric, hyphen, and underscore to prevent
    // label-injection via specially-crafted name strings. Non-matching entries are skipped
    // fail-closed (same posture as an empty name).
    const NAME_CHARSET = /^[a-z0-9_-]+$/;
    if (!NAME_CHARSET.test(name)) {
      console.warn(
        `[canon] routine: name '${name}' does not match ^[a-z0-9_-]+$ — skipping (${filePath})`,
      );
      return makeEmptyRoutine(filePath, source);
    }
    return buildRoutine(fm, body.trim(), filePath, source);
  } catch {
    return makeEmptyRoutine(filePath, source);
  }
}

function buildRoutine(
  fm: Record<string, unknown>,
  body: string,
  filePath: string,
  source: "project" | "plugin",
): Routine {
  const routine: Routine = {
    body,
    filePath,
    guardrails: parseGuardrails((fm.guardrails as Record<string, unknown>) ?? {}),
    name: fm.name as string,
    needs: parseNeeds((fm.needs as Record<string, unknown>) ?? {}),
    recurrence: fm.recurrence === "one-shot" ? "one-shot" : "standing",
    repos: Array.isArray(fm.repos)
      ? (fm.repos as string[]).filter((r) => typeof r === "string")
      : [],
    scope: fm.scope === "account" ? "account" : "repo",
    source,
    status: validStatus(fm.status) ?? "draft",
    title: (fm.title as string) || "",
    trigger: parseTrigger((fm.trigger as Record<string, unknown>) ?? {}),
  };
  const bt = fm.binding_target as string | undefined;
  if (bt === "cloud-routine" || bt === "desktop-task") routine.binding_target = bt;
  return routine;
}

function parseTrigger(raw: Record<string, unknown>): Routine["trigger"] {
  const trigger: Routine["trigger"] = { kind: validTriggerKind(raw.kind) ?? "schedule" };
  if (raw.cron != null) trigger.cron = String(raw.cron);
  if (raw.event != null) trigger.event = String(raw.event);
  return trigger;
}

function parseNeeds(raw: Record<string, unknown>): Routine["needs"] {
  return { daemon: raw.daemon === true, state: validNeedsState(raw.state) ?? "git-native" };
}

function parseGuardrails(raw: Record<string, unknown>): Routine["guardrails"] {
  return {
    consent: validConsent(raw.consent) ?? "opt-in",
    mutates_running_build: raw.mutates_running_build === true,
    repo_writes: validRepoWrites(raw.repo_writes) ?? "none",
  };
}

// ---------------------------------------------------------------------------
// File loader
// ---------------------------------------------------------------------------

/**
 * Read and parse a single routine file. Fail-open: returns a routine with
 * `name: ""` for any read/parse error so callers can filter.
 */
export async function loadRoutineFile(
  filePath: string,
  source: "project" | "plugin",
): Promise<Routine> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseRoutine(content, filePath, source);
  } catch {
    return makeEmptyRoutine(filePath, source);
  }
}

// ---------------------------------------------------------------------------
// Directory loader
// ---------------------------------------------------------------------------

/**
 * Load all routine `.md` files from a directory.
 *
 * - ENOENT → `[]` (fail-open, mirrors `loadMdFilesFromDir`)
 * - Malformed files (name === "") → filtered out
 * - Skips `README.md` and files inside `.claude/` subdirectory
 */
export async function loadRoutinesFromDir(
  dir: string,
  source: "project" | "plugin",
): Promise<Routine[]> {
  try {
    const entries = await readdir(dir);
    const mdFiles = entries.filter(
      (f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("."),
    );
    const routines = await Promise.all(mdFiles.map((f) => loadRoutineFile(join(dir, f), source)));
    return routines.filter((r) => r.name !== "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "[canon] routine: failed to load routines from",
        dir,
        ":",
        err instanceof Error ? err.message : err,
      );
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Precedence loader
// ---------------------------------------------------------------------------

/**
 * Load all routines with project-local precedence.
 *
 * - Project-local: `{projectDir}/.canon/routines/` (source: "project")
 * - Plugin: `{pluginDir}/routines/` (source: "plugin")
 * - On `name` conflict, project-local wins (mirrors `loadAllPrinciples` seenIds merge).
 */
export async function loadAllRoutines(projectDir: string, pluginDir: string): Promise<Routine[]> {
  const projectRoutines = await loadRoutinesFromDir(
    join(projectDir, CANON_DIR, "routines"),
    "project",
  );
  const pluginRoutines = await loadRoutinesFromDir(join(pluginDir, "routines"), "plugin");

  // Project-local takes precedence on name conflict
  const seenNames = new Set(projectRoutines.map((r) => r.name));
  const merged = [...projectRoutines, ...pluginRoutines.filter((r) => !seenNames.has(r.name))];

  return merged;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyRoutine(filePath: string, source: "project" | "plugin"): Routine {
  return {
    body: "",
    filePath,
    guardrails: {
      consent: "opt-in",
      mutates_running_build: false,
      repo_writes: "none",
    },
    name: "",
    needs: { daemon: false, state: "git-native" },
    recurrence: "standing",
    repos: [],
    scope: "repo",
    source,
    status: "draft",
    title: "",
    trigger: { kind: "schedule" },
  };
}

function validStatus(v: unknown): Routine["status"] | undefined {
  if (v === "enabled" || v === "disabled" || v === "draft") return v;
  return undefined;
}

function validTriggerKind(v: unknown): Routine["trigger"]["kind"] | undefined {
  if (v === "schedule" || v === "github-event" || v === "api") return v;
  return undefined;
}

function validNeedsState(v: unknown): Routine["needs"]["state"] | undefined {
  if (v === "git-native" || v === "local-canon") return v;
  return undefined;
}

function validRepoWrites(v: unknown): Routine["guardrails"]["repo_writes"] | undefined {
  if (v === "notify-only" || v === "draft-pr" || v === "none") return v;
  return undefined;
}

function validConsent(v: unknown): Routine["guardrails"]["consent"] | undefined {
  if (v === "opt-in" || v === "tier-gated") return v;
  return undefined;
}
