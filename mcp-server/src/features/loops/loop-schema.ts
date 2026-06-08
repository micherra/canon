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
  tools: z.array(z.string()).default([]),
});

const TransitionRuleSchema = z.object({
  append: z.boolean().optional(),
  field: z.string(),
  from: z.string().optional(),
  message: z.string(),
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
  observe: ObserveSchema.optional().default({ mcp: [], tools: [] }),
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

/**
 * Guardrail 2 helper — checks observe tools against built-in + author denylists.
 *
 * Returns an error string when a violation is found, or null when clean.
 * Extracted to keep parseLoopDefinition under the cognitive-complexity limit.
 */
function checkObserveMutationGuardrail(
  observeTools: ReadonlySet<string>,
  forbiddenTools: ReadonlyArray<string>,
): string | null {
  // (a) Built-in mutation denylist — always enforced when mutates_build:false.
  const builtinOffenders = BUILTIN_MUTATION_TOOLS.filter((t) => observeTools.has(t));
  if (builtinOffenders.length > 0) {
    return (
      `mutation tool(s) declared in observe while mutates_build is false: ` +
      `${builtinOffenders.join(", ")} (built-in mutation denylist: Write, Edit, Bash, NotebookEdit)`
    );
  }

  // (b) Author-specified forbidden_tools — additive on top of built-in set.
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
 *    Built-in denylist (Write/Edit/Bash/NotebookEdit) always enforced; forbidden_tools additive.
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
    const guardError = checkObserveMutationGuardrail(observeTools, def.guardrails.forbidden_tools);
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
