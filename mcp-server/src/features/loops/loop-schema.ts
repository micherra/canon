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

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const FiringPostureSchema = z.object({
  autonomous: z.enum(["auto", "opt-in", "disabled"]).default("disabled"),
  "light-touch": z.enum(["auto", "opt-in", "disabled"]).default("disabled"),
  supervised: z.enum(["auto", "opt-in", "disabled"]).default("opt-in"),
});

const TriggerSchema = z.object({
  fired_by: z.literal("orchestrator"),
  firing_posture: FiringPostureSchema.optional(),
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
 * Parse and validate a raw loop-definition frontmatter object.
 *
 * Returns a ToolResult-shaped discriminated union — never throws for expected
 * conditions (malformed definition is expected; ADR-002 errors-as-values).
 *
 * Mechanical determinism guardrails (dc-05, loops-phase-a-05) enforced here:
 * 1. self-paced + mutates_build:true → rejected.
 * 2. mutates_build:false + forbidden tool in observe → rejected (names the tool(s)).
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

  // ── Guardrail 2: mutates_build:false + forbidden tool intersection ─────────
  if (def.guardrails.mutates_build === false && def.guardrails.forbidden_tools.length > 0) {
    const observeTools = new Set([...def.observe.tools, ...def.observe.mcp]);
    const offenders = def.guardrails.forbidden_tools.filter((t) => observeTools.has(t));
    if (offenders.length > 0) {
      return {
        error:
          `forbidden tool(s) declared in observe while mutates_build is false: ` +
          `${offenders.join(", ")} (listed in guardrails.forbidden_tools)`,
        ok: false,
      };
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
