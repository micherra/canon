/**
 * Loop-definition Zod schema + LoopDefinition type + parseLoopDefinition.
 *
 * This is a pure leaf module — no I/O, no runtime. The registry loader (A2) does I/O;
 * this file is imported by everything else.
 *
 * Design decisions honoured:
 * - loops-phase-a-01: markdown + YAML frontmatter in loops/ mirrors principle artifact class
 * - loops-phase-a-03: interval-first; self-paced reserved (schema accepts it, runner rejects it)
 * - loops-phase-a-05: determinism guardrail is mechanical, enforced here at parse time
 *
 * Principle alignment:
 * - errors-as-values: parseLoopDefinition returns ToolResult-shaped union, never throws
 * - simplicity-first: one schema file, one parse function, no I/O
 * - all-schema-fields-optional invariant: new fields default safely; absent optional field → never throws
 */

import { z } from "zod";

// ── Built-in mutation denylist (dc-05 / Comment 1 fix) ────────────────────────
// These tools mutate the build and are ALWAYS forbidden when mutates_build:false,
// regardless of whether the loop author specifies forbidden_tools.
// frozen tuple — exhaustiveness is stable for Phase A+B; Phase C may extend.
export const BUILTIN_MUTATION_TOOLS: ReadonlyArray<string> = [
  "Write",
  "Edit",
  "Bash",
  "NotebookEdit",
] as const;

// ── Built-in forbidden MCP denylist (DR-005 / Phase C) ────────────────────────
// MCP tools that can mutate build flow; forbidden in observe when mutates_build:false.
// `get_next_escalation_strategy` can trigger architectural build-flow changes.
export const BUILTIN_FORBIDDEN_MCP: ReadonlyArray<string> = [
  "get_next_escalation_strategy",
] as const;

// ── Orchestrator-consumed follow-on actions (derive-from-const, watch_BBBBBB1) ──
// A loop DECLARES one of these on a transition; the read-only loop/runner SURFACES it;
// the orchestrator (allowed to mutate) CONSUMES the signal and acts. The loop/runner
// NEVER executes these. Extend by explicit diff only; each entry must ship with a
// documented orchestrator-consumption contract (see CLAUDE.md § Loop Framework).
// canon:allow-unwired: derive-from-const pattern; ORCHESTRATOR_ACTIONS consumed internally via z.enum on line 117
export const ORCHESTRATOR_ACTIONS = [
  "auto-triage-fix",
  "auto-plugin-update",
  "run-learner",
  "run-evolve",
  "auto-enable-merge",
  "auto-update-branch",
  "auto-staleness-refresh",
] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];

// Read-only gh/git subcommand prefixes admitted under the Bash carve-out (decision loops-phase-b-01).
// Extend by explicit diff only; every entry must be genuinely read-only.
export const READ_ONLY_SHELL_COMMANDS: ReadonlyArray<string> = [
  "gh pr view",
  "gh pr list",
  "gh pr checks",
  "gh release list",
  "gh release view",
  "gh api",
  "gh repo view",
  "gh run list",
  "gh run view",
  "git log",
  "git status",
  "git rev-list",
  "git show",
  "git diff",
  "git rev-parse",
  "stat",
  "date",
] as const;

// ── Sub-schemas ────────────────────────────────────────────────────────────────

// Per-tier defaults: supervised → opt-in (safe default), autonomous/light-touch → disabled.
// These are the documented safe defaults; do not change without a design update.
//
// The outer .default({...}) must enumerate all per-field defaults explicitly.
// Zod applies the outer default value as-is when the key is absent — it does NOT
// re-run inner field defaults on the default value. So we spell them out here.
const FIRING_POSTURE_DEFAULTS = {
  autonomous: "disabled" as const,
  "light-touch": "disabled" as const,
  supervised: "opt-in" as const,
};

const FiringPostureSchema = z
  .object({
    autonomous: z.enum(["auto", "opt-in", "disabled"]).default("disabled"),
    "light-touch": z.enum(["auto", "opt-in", "disabled"]).default("disabled"),
    supervised: z.enum(["auto", "opt-in", "disabled"]).default("opt-in"),
  })
  .default(FIRING_POSTURE_DEFAULTS);

const TriggerSchema = z.object({
  fired_by: z.literal("orchestrator"),
  firing_posture: FiringPostureSchema,
  lifecycle_hook: z.enum(["post-ship", "on-long-dispatch", "session-start"]),
});

const StateSchema = z.object({
  path: z.string(),
  scope: z.enum(["workspace", "session"]),
  snapshot: z
    .array(z.string())
    .min(1, "state.snapshot must be a YAML list with at least one field name"),
});

const ObserveSchema = z.object({
  mcp: z.array(z.string()).default([]),
  shell_commands: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
});

const TransitionRuleSchema = z.object({
  append: z.boolean().optional(),
  field: z.string(),
  from: z.string().optional(),
  message: z.string(),
  orchestrator_action: z.enum(ORCHESTRATOR_ACTIONS).optional(),
  terminate: z.boolean().optional(),
  to: z.string().optional(),
});

const SurfaceSchema = z.object({
  on_transition: z
    .array(TransitionRuleSchema)
    .min(1, "surface.on_transition must be a YAML list with at least one rule"),
});

const TerminateSchema = z.object({
  when: z
    .array(z.string())
    .min(1, "terminate.when must be a YAML list with at least one condition"),
});

const GuardrailsSchema = z.object({
  forbidden_tools: z.array(z.string()).default([]),
  mutates_build: z.boolean(),
});

// ── Mode-discriminated union ───────────────────────────────────────────────────
// No default on the discriminant — TypeScript enforces exhaustiveness.

const IntervalScheduleSchema = z.object({
  interval: z.string({ message: "schedule.interval is required for interval-mode loops" }),
  max_ticks: z
    .number({ message: "schedule.max_ticks is required for interval-mode loops" })
    .int()
    .min(1),
});

const SelfPacedScheduleSchema = z.object({
  cadence_hint: z.object({
    active: z.string(),
    idle: z.string(),
  }),
  max_wall: z.string().optional(), // e.g. "2h"; "0" or absent = bounded by terminate conditions only
});

const IntervalLoopSchema = z.object({
  mode: z.literal("interval"),
  schedule: IntervalScheduleSchema,
});

const SelfPacedLoopSchema = z.object({
  mode: z.literal("self-paced"),
  schedule: SelfPacedScheduleSchema,
});

const ModeSchema = z.discriminatedUnion("mode", [IntervalLoopSchema, SelfPacedLoopSchema]);

// ── Full loop-definition schema ───────────────────────────────────────────────
// All fields optional where safe; required fields declared explicitly.

const LoopDefinitionBaseSchema = z.object({
  guardrails: GuardrailsSchema,
  id: z.string(),
  observe: ObserveSchema.optional().default({ mcp: [], shell_commands: [], tools: [] }),
  state: StateSchema,
  status: z.enum(["active", "shadow", "disabled"]).default("active"),
  surface: SurfaceSchema,
  terminate: TerminateSchema,
  title: z.string(),
  trigger: TriggerSchema.optional(),
});

/**
 * Full loop-definition schema — a discriminated union on `mode`, merged with shared fields.
 * The superRefine cross-field checks (snapshot ↔ on_transition) live in parseLoopDefinition
 * post-parse rather than here, keeping the schema focused on structural validation.
 */
export const LoopDefinitionSchema = z
  .intersection(LoopDefinitionBaseSchema, ModeSchema)
  .superRefine((data, ctx) => {
    // Cross-field: every transition rule's field must appear in state.snapshot
    const snapshotFields = new Set(data.state.snapshot);
    for (const rule of data.surface.on_transition) {
      if (!snapshotFields.has(rule.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `transition references field '${rule.field}' not in state.snapshot [${data.state.snapshot.join(", ")}]`,
          path: ["surface", "on_transition"],
        });
      }
    }
  });

export type LoopDefinition = z.infer<typeof LoopDefinitionSchema>;

// ── Parse result type ──────────────────────────────────────────────────────────

export type ParseLoopResult =
  | { ok: true; definition: LoopDefinition }
  | { ok: false; error: string };

// ── Options ────────────────────────────────────────────────────────────────────

export type ParseLoopOptions = {
  /** When provided, validates that definition.id equals this stem (filename without .md). */
  idFromFilename?: string;
};

// ── Shell metacharacter reject set (Codex P1) ─────────────────────────────────
// Any of these in a declared shell_command entry → immediate rejection.
// Read-only observe commands need none of these. Rejecting `$` and `()` also kills `$(...)`
// command substitution. Rejecting `;` and `&` kills chaining. Rejecting `|`, `<`, `>` kills
// pipes and redirections. Backtick kills legacy command substitution.
const SHELL_METACHARS = [";", "&", "|", "<", ">", "`", "$", "(", ")", "\n", "\r"] as const;

// ── gh api mutating-flag tokens (Codex P1) ────────────────────────────────────
// When a shell_command starts with 'gh api', these token PREFIXES flip it from GET to POST/PATCH/DELETE.
// A token that starts with any of these prefixes is a write-field flag regardless of glued value.
const GH_API_WRITE_FLAG_PREFIXES = ["-f", "-F", "--field", "--raw-field", "--input"] as const;

/**
 * Extracts the method value from a -X or --method token or its successor.
 *
 * Handles all pflag forms:
 *   - Token `-XPOST` (glued): returns "POST"
 *   - Token `-X=POST` (equals): returns "POST"
 *   - Token `-X` with next token `POST` (space): returns "POST" via nextToken
 *   - Token `--method=POST` (equals): returns "POST"
 *   - Token `--method` with next token `POST` (space): returns "POST" via nextToken
 *
 * Returns null when the token is unrecognized or no value is available.
 */
function extractMethodValue(token: string, nextToken: string | undefined): string | null {
  // Short form: -X
  if (token.startsWith("-X")) {
    const rest = token.slice(2); // everything after -X
    if (rest.startsWith("=")) return rest.slice(1); // -X=POST
    if (rest.length > 0) return rest; // -XPOST (glued)
    return nextToken ?? null; // -X POST (space-separated)
  }
  // Long form: --method
  if (token.startsWith("--method")) {
    const rest = token.slice(8); // everything after --method
    if (rest.startsWith("=")) return rest.slice(1); // --method=POST
    if (rest.length === 0) return nextToken ?? null; // --method POST (space-separated)
    return null; // --methodXXX — not a method flag (e.g. --methodical would fall here; safe to ignore)
  }
  return null;
}

/**
 * Returns true when the given token is a gh api write-field flag.
 * Covers both standalone (`-f`, `--field`) and glued forms (`-fbody=x`, `--field=k=v`).
 *
 * Write-field flag prefixes: -f, -F (single-dash single-letter) and --field, --raw-field, --input.
 * A token matches when it IS the prefix or STARTS with the prefix (glued value appended).
 * `--format` does NOT start with `--field`, so it is safe.
 */
function isWriteFieldToken(token: string): boolean {
  return GH_API_WRITE_FLAG_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix));
}

/**
 * Checks whether a `gh api` entry uses a mutating method or write-field flag.
 * Returns an error string if mutating, null if read-only (GET).
 *
 * Tokenizes on whitespace so each token is examined individually; this catches
 * both space-separated forms (`-X POST`, `--method POST`) and glued/equals
 * forms (`-XPOST`, `-X=POST`, `--method=POST`, `-fbody=x`).
 *
 * Admitted: `-X GET`, `-XGET`, `--method GET`, `--method=GET` (all GET variants).
 * Rejected: any non-GET method value; any write-field flag prefix.
 */
function checkGhApiMutatingFlags(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // ── Method flag check ────────────────────────────────────────────────────
    if (token.startsWith("-X") || token.startsWith("--method")) {
      const method = extractMethodValue(token, tokens[i + 1]);
      if (method !== null && method.toUpperCase() !== "GET") {
        return (
          `gh api shell_command '${cmd}' uses method '${method}' which is a mutating method ` +
          `(only GET is allowed under mutates_build:false)`
        );
      }
      // method === null: incomplete flag at end of command — not a known bypass; skip
      // method.toUpperCase() === "GET": read-only, continue scanning
      continue;
    }
    // ── Write-field flag check ───────────────────────────────────────────────
    if (isWriteFieldToken(token)) {
      return (
        `gh api shell_command '${cmd}' contains write-field flag '${token}' ` +
        `which makes this a mutating gh api call (not allowed under mutates_build:false)`
      );
    }
  }
  return null;
}

// ── date read-only ALLOWLIST (staleness-01 hardening — allowlist rethink) ──────
// GNU/BSD `date` has multiple clock-SETTING shapes: `-s`/`--set` (GNU set), `-f <fmt>
// <new_date>` (BSD parse-and-set), and a bare positional operand `[[[[[cc]yy]mm]dd]HH]MM[.ss]`
// (BSD set-with-no-flag). Two successive denylist patches each missed one shape (positional,
// then `-f`), so this guard is a fail-closed ALLOWLIST: a `date` invocation is admitted ONLY
// when every token after `date` is a known read-only shape; anything else — unknown flags AND
// any bare positional operand — is rejected. The KG-age observe only ever needs bare `date` /
// `date +%s`, so a strict read-only allowlist cannot break legitimate use.

// Read-only flags that take a following value token. Bare form consumes exactly one following
// token (so its value is never examined as a positional operand); a `=`-glued form
// (`--date=<str>`) or a directly-glued BSD `-v` adjustment (`-v+1d`) is self-contained.
//   -r <epoch>       BSD print-given-epoch
//   -d/--date <str>  GNU print-given-date
//   -v <adjust>      BSD display-adjust (never sets the clock)
const DATE_READ_VALUE_FLAGS = ["-r", "-d", "--date", "-v"] as const;

// Read-only flags that take NO value: UTC/RFC output selectors and BSD `-j` (do-not-set).
// `-I`/`-Iseconds`/`-I<spec>` ISO-output selectors are matched by prefix; the rest exactly.
const DATE_READONLY_NOVALUE_FLAGS = ["-u", "-R", "-j"] as const;

/** Per-token classification result for `checkDateMutatingFlags`'s loop. */
type DateTokenVerdict =
  | { kind: "reject"; message: string }
  | { kind: "consume-next" }
  | { kind: "skip" };

/**
 * Classifies a read-value `date` flag token (`-r`, `-d`, `--date`, `-v`). Bare flag →
 * consume-next (its value token must not be re-examined as a positional operand); a
 * `=`-glued form (`--date=x`) or directly-glued `-v` adjustment (`-v+1d`) → skip
 * (self-contained). Returns null when `token` is not a read-value flag.
 */
function classifyDateReadValueFlag(token: string): DateTokenVerdict | null {
  for (const f of DATE_READ_VALUE_FLAGS) {
    if (token === f) {
      return { kind: "consume-next" };
    }
    if (token.startsWith(`${f}=`)) {
      return { kind: "skip" };
    }
  }
  // Directly-glued BSD `-v` adjustment: -v+1d, -v-1d, -v1d (value not `=`-separated).
  if (token.startsWith("-v") && token.length > 2) {
    return { kind: "skip" };
  }
  return null;
}

/** True when `token` is a read-only no-value date flag (`-u`, `-R`, `-j`, or an `-I*` ISO selector). */
function isDateReadOnlyNoValueFlag(token: string): boolean {
  return token.startsWith("-I") || DATE_READONLY_NOVALUE_FLAGS.some((f) => token === f);
}

/** Builds the fail-closed rejection message for a non-allowlisted `date` token. */
function buildDateRejectError(cmd: string, token: string): string {
  return (
    `date shell_command '${cmd}' has non-read-only token '${token}' ` +
    `(only read-only date forms are allowed under mutates_build:false: bare 'date', '+FORMAT', ` +
    `-u/-R/-I*/-j, and -r/-d/--date/-v <value>; set-clock flags '-s'/'--set'/'-f' and bare ` +
    `positional operands set the system clock and are rejected)`
  );
}

/**
 * Classifies a single `date` argument token against the read-only ALLOWLIST. Admitted:
 * `+FORMAT`; read-value flags `-r`/`-d`/`--date`/`-v` (and glued forms); no-value flags
 * `-u`/`-R`/`-j`/`-I*`. Everything else — set-clock flags (`-s`/`--set`/`-f`), unknown
 * `-`-flags, and any bare positional operand — is rejected fail-closed. Extracted so the
 * loop in checkDateMutatingFlags stays a flat dispatch under the cognitive-complexity limit.
 */
function classifyDateToken(cmd: string, token: string): DateTokenVerdict {
  if (token.startsWith("+")) {
    return { kind: "skip" }; // +FORMAT — read-only output selector, never a clock-set operand
  }
  const readValueVerdict = classifyDateReadValueFlag(token);
  if (readValueVerdict !== null) {
    return readValueVerdict;
  }
  if (isDateReadOnlyNoValueFlag(token)) {
    return { kind: "skip" };
  }
  return { kind: "reject", message: buildDateRejectError(cmd, token) };
}

/**
 * Checks whether a `date` entry is admitted by the read-only allowlist.
 * Returns an error string when any token is not a known read-only shape, null when clean.
 *
 * Admitted: `date` (no args), `date +%s`, `date -u`, `date -Iseconds`, `date -r 1234567890`
 * (BSD read-given-epoch — the digit operand is consumed by `-r`, not classified), `date -d "..."`,
 * `date -v +1d` (BSD display-adjust). Rejected fail-closed: `-s`/`--set`/`-f` set-clock flags
 * and their glued forms; any unknown `-`-prefixed flag; any bare positional operand (the BSD
 * `[[[[[cc]yy]mm]dd]HH]MM[.ss]` clock-set form) — all-digits or not.
 */
function checkDateMutatingFlags(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/).slice(1); // skip the leading "date" token

  for (let i = 0; i < tokens.length; i++) {
    const verdict = classifyDateToken(cmd, tokens[i]);
    if (verdict.kind === "reject") {
      return verdict.message;
    }
    if (verdict.kind === "consume-next" && tokens[i + 1] !== undefined) {
      i++;
    }
  }
  return null;
}

/**
 * Validates a single shell_command entry for read-only safety (Codex P1 hardening).
 *
 * Checks in order:
 * 1. Shell metacharacter rejection (;, &, |, <, >, `, $, (, ), \n, \r)
 * 2. Prefix allowlist — must be on READ_ONLY_SHELL_COMMANDS
 * 3. gh api mutating-flag rejection (only for 'gh api' entries)
 * 4. date mutating-flag rejection (only for 'date' entries, staleness-01)
 *
 * Returns an error string on violation, null when safe.
 * Extracted from checkReadOnlyShell to keep both functions below complexity 12.
 */
function checkSingleShellCommand(cmd: string): string | null {
  // Codex P1 check 1: reject shell metacharacters
  const metaChar = SHELL_METACHARS.find((c) => cmd.includes(c));
  if (metaChar !== undefined) {
    const display = metaChar === "\n" ? "\\n" : metaChar === "\r" ? "\\r" : metaChar;
    return (
      `shell_command '${cmd}' contains shell metacharacter '${display}' ` +
      `(metacharacters are not allowed in read-only observe commands under mutates_build:false)`
    );
  }

  // Prefix allowlist check
  const allowed = READ_ONLY_SHELL_COMMANDS.some(
    (prefix) => cmd === prefix || cmd.startsWith(`${prefix} `),
  );
  if (!allowed) {
    return (
      `shell_command '${cmd}' is not on the read-only allowlist ` +
      `(mutating or unknown command rejected under mutates_build:false)`
    );
  }

  // Codex P1 check 2: gh api mutating-flag rejection
  if (cmd === "gh api" || cmd.startsWith("gh api ")) {
    return checkGhApiMutatingFlags(cmd);
  }

  // staleness-01 check: date mutating-flag rejection
  if (cmd === "date" || cmd.startsWith("date ")) {
    return checkDateMutatingFlags(cmd);
  }

  return null;
}

/**
 * Guardrail 2 helper — checks whether Bash is safe to admit under the read-only carve-out.
 *
 * `Bash` is dual-use: `git log` reads, `git push` writes. This helper validates that every
 * declared shell_command passes checkSingleShellCommand (Codex P1 hardening):
 *
 * 1. Metacharacter rejection — closes semicolon-chain and command-substitution exploits.
 * 2. Prefix allowlist — entry must be on READ_ONLY_SHELL_COMMANDS.
 * 3. gh api mutating-flag rejection — closes -f / -X POST exploits on gh api entries.
 *
 * Returns an error string when a violation is found, or null when admitted.
 * Extracted to keep checkObserveMutationGuardrail under the cognitive-complexity limit.
 */
function checkReadOnlyShell(shellCommands: ReadonlyArray<string>): string | null {
  if (shellCommands.length === 0) {
    return (
      "Bash declared in observe while mutates_build is false but observe.shell_commands is empty " +
      "— declare the read-only commands this loop runs"
    );
  }
  for (const cmd of shellCommands) {
    const cmdError = checkSingleShellCommand(cmd);
    if (cmdError !== null) {
      return cmdError;
    }
  }
  return null;
}

/**
 * Guardrail 2 helper — checks observe tools against built-in + author denylists.
 *
 * `Bash` receives a special read-only carve-out (decision loops-phase-b-01): when Bash is in
 * observe.tools and mutates_build:false, it is admitted ONLY if shell_commands is non-empty and
 * every entry matches READ_ONLY_SHELL_COMMANDS. Write/Edit/NotebookEdit remain unconditionally
 * rejected — the carve-out is Bash-only.
 *
 * Returns an error string when a violation is found, or null when clean.
 * Extracted to keep parseLoopDefinition under the cognitive-complexity limit.
 */
function checkObserveMutationGuardrail(
  observeTools: ReadonlySet<string>,
  forbiddenTools: ReadonlyArray<string>,
  shellCommands: ReadonlyArray<string>,
): string | null {
  // (a) Built-in mutation denylist — always enforced when mutates_build:false,
  //     EXCEPT Bash which is handled separately via the read-only carve-out.
  const nonBashBuiltinOffenders = BUILTIN_MUTATION_TOOLS.filter(
    (t) => t !== "Bash" && observeTools.has(t),
  );
  if (nonBashBuiltinOffenders.length > 0) {
    return (
      `mutation tool(s) declared in observe while mutates_build is false: ` +
      `${nonBashBuiltinOffenders.join(", ")} (built-in mutation denylist: Write, Edit, Bash, NotebookEdit)`
    );
  }

  // (b) Bash read-only carve-out — admitted only with a validated read-only shell_commands list.
  if (observeTools.has("Bash")) {
    const bashError = checkReadOnlyShell(shellCommands);
    if (bashError !== null) {
      return bashError;
    }
  }

  // (c) Built-in forbidden MCP denylist — tools that can mutate build flow (DR-005 / Phase C).
  //     Checked against the full observeTools set (which includes both tools and mcp).
  const forbiddenMcpOffenders = BUILTIN_FORBIDDEN_MCP.filter((t) => observeTools.has(t));
  if (forbiddenMcpOffenders.length > 0) {
    return (
      `forbidden MCP tool(s) declared in observe while mutates_build is false: ` +
      `${forbiddenMcpOffenders.join(", ")} (built-in forbidden MCP denylist: get_next_escalation_strategy)`
    );
  }

  // (d) Author-specified forbidden_tools — additive on top of built-in set.
  const authorOffenders = forbiddenTools.filter((t) => observeTools.has(t));
  if (authorOffenders.length > 0) {
    return (
      `forbidden tool(s) declared in observe while mutates_build is false: ` +
      `${authorOffenders.join(", ")} (listed in guardrails.forbidden_tools)`
    );
  }

  return null;
}

/**
 * Parse and validate a raw loop-definition frontmatter object.
 *
 * Returns a ToolResult-shaped discriminated union — never throws for expected
 * conditions (malformed definition is expected; ADR-002 errors-as-values).
 *
 * Mechanical determinism guardrails (dc-05, loops-phase-a-05) enforced here:
 * 1. self-paced + mutates_build:true → rejected.
 * 2. mutates_build:false + mutation tool in observe → rejected (names the tool(s)).
 *    Built-in denylist (Write/Edit/NotebookEdit) always enforced; forbidden_tools additive.
 *    Bash carve-out (loops-phase-b-01): Bash admitted ONLY when observe.shell_commands is
 *    non-empty and every entry matches READ_ONLY_SHELL_COMMANDS — empty list rejects, any
 *    non-allowlisted entry (e.g. "git push") rejects, naming the offending command.
 * 3. Cross-field: on_transition.field not in state.snapshot → rejected (in superRefine above).
 * 4. id !== idFromFilename → rejected (when idFromFilename is provided).
 */
export function parseLoopDefinition(frontmatter: unknown, opts: ParseLoopOptions): ParseLoopResult {
  const parsed = LoopDefinitionSchema.safeParse(frontmatter);

  if (!parsed.success) {
    // Build a clear, human-readable error message from Zod issues.
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    return { error: issues, ok: false };
  }

  const def = parsed.data;

  // ── Guardrail 1: self-paced loops must declare mutates_build:false ─────────
  if (def.mode === "self-paced" && def.guardrails.mutates_build === true) {
    return {
      error: "self-paced loops must declare guardrails.mutates_build: false (observe+surface only)",
      ok: false,
    };
  }

  // ── Guardrail 2: mutates_build:false + mutation tool in observe ────────────
  if (def.guardrails.mutates_build === false) {
    const observeTools = new Set([...def.observe.tools, ...def.observe.mcp]);
    const guardError = checkObserveMutationGuardrail(
      observeTools,
      def.guardrails.forbidden_tools,
      def.observe.shell_commands,
    );
    if (guardError !== null) {
      return { error: guardError, ok: false };
    }
  }

  // ── Guardrail 3: id must match filename stem ───────────────────────────────
  if (opts.idFromFilename !== undefined && def.id !== opts.idFromFilename) {
    return {
      error: `id '${def.id}' must match filename stem '${opts.idFromFilename}'`,
      ok: false,
    };
  }

  return { definition: def, ok: true };
}
