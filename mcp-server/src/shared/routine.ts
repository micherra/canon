import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CANON_DIR } from "./constants.ts";
import { splitFrontmatter } from "./lib/frontmatter.ts";
import { brandUntrusted, type UntrustedText } from "./lib/overlay-untrusted-text.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Routine = {
  /** Unique kebab-case identifier (peer of a principle id). */
  name: string;
  /** Free-text title — opaque box; must render via renderUntrusted* for model output. */
  title: UntrustedText;
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
  /** Free-text body — opaque box; must render via renderUntrusted* for model output. */
  body: UntrustedText;
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
    // Brand the free-text body at the load boundary.
    body: brandUntrusted(body),
    filePath,
    guardrails: parseGuardrails((fm.guardrails as Record<string, unknown>) ?? {}),
    name: fm.name as string,
    needs: parseNeeds((fm.needs as Record<string, unknown>) ?? {}),
    recurrence: fm.recurrence === "one-shot" ? "one-shot" : "standing",
    repos: Array.isArray(fm.repos)
      ? (fm.repos as string[]).filter((r) => typeof r === "string" && REPO_CHARSET.test(r))
      : [],
    scope: fm.scope === "account" ? "account" : "repo",
    source,
    status: validStatus(fm.status) ?? "draft",
    // Brand the free-text title at the load boundary.
    title: brandUntrusted((fm.title as string) || ""),
    trigger: parseTrigger((fm.trigger as Record<string, unknown>) ?? {}),
  };
  const bt = fm.binding_target as string | undefined;
  if (bt === "cloud-routine" || bt === "desktop-task") routine.binding_target = bt;
  return routine;
}

// Charset guards for trigger fields — closed identifier/grammar domains.
// Non-matching values are dropped (undefined) rather than passed through unfenced.
const CRON_CHARSET = /^[\d\s*/,?LWC#-]+$/;
// Event names allow pipe to support GitHub multi-event filters (e.g. "push|pull_request").
const EVENT_CHARSET = /^[A-Za-z0-9._:|-]+$/;
// Repo entries: owner/name style identifiers only.
const REPO_CHARSET = /^[A-Za-z0-9._/-]+$/;

function parseTrigger(raw: Record<string, unknown>): Routine["trigger"] {
  const trigger: Routine["trigger"] = { kind: validTriggerKind(raw.kind) ?? "schedule" };
  if (raw.cron != null) {
    const cron = String(raw.cron);
    if (CRON_CHARSET.test(cron)) {
      trigger.cron = cron;
    } else {
      console.warn(`[canon] parseTrigger: cron '${cron}' failed charset — skipping`);
    }
  }
  if (raw.event != null) {
    const event = String(raw.event);
    if (EVENT_CHARSET.test(event)) {
      trigger.event = event;
    } else {
      console.warn(`[canon] parseTrigger: event '${event}' failed charset — skipping`);
    }
  }
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
    body: brandUntrusted(""),
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
    title: brandUntrusted(""),
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
