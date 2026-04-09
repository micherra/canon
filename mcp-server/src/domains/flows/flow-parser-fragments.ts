/**
 * Fragment resolution helpers for the flow parser.
 *
 * Handles param validation, state merging, and spawn instruction merging
 * for fragment includes resolved by resolveFragments().
 */

import type {
  ConsultationFragment,
  FragmentDefinition,
  FragmentInclude,
  StateDefinition,
  TypedParam,
} from "./flow-definition-schemas.ts";

/**
 * Type guard: returns true if value is a typed param object ({ type, default? }).
 * Distinguishes new-format typed params from old-format scalar/null values.
 */
export function isTypedParam(v: unknown): v is TypedParam {
  return v !== null && typeof v === "object" && "type" in v;
}

/** Check if a param is required (no default) and not provided. */
export function isParamMissing(
  paramName: string,
  paramDef: unknown,
  withParams: Record<string, unknown>,
): boolean {
  if (paramName in withParams) return false;
  if (isTypedParam(paramDef)) return paramDef.default === undefined;
  return paramDef === null || paramDef === undefined;
}

/** Extract the default value for a single param definition. */
export function getParamDefault(paramDef: unknown): (string | number | boolean) | undefined {
  if (isTypedParam(paramDef)) {
    return paramDef.default as string | number | boolean | undefined;
  }
  // Old format: non-null scalar is a default value (includes false)
  if (paramDef !== null && paramDef !== undefined) {
    return paramDef as string | number | boolean;
  }
  return undefined;
}

/** Validate required params and build the effective params map (defaults + overrides). */
export function buildEffectiveParams(
  definition: FragmentDefinition,
  include: FragmentInclude,
): Record<string, string | number | boolean> {
  const withParams = include.with ?? {};

  // Validate required params
  if (definition.params) {
    for (const [paramName, paramDef] of Object.entries(definition.params)) {
      if (isParamMissing(paramName, paramDef, withParams)) {
        throw new Error(
          `Fragment "${include.fragment}" requires param "${paramName}" but it was not provided`,
        );
      }
    }
  }

  // Build effective params: defaults then with overrides
  const defaults: Record<string, string | number | boolean> = {};
  for (const [paramName, paramDef] of Object.entries(definition.params ?? {})) {
    const defaultVal = getParamDefault(paramDef);
    if (defaultVal !== undefined) {
      defaults[paramName] = defaultVal;
    }
  }

  return {
    ...defaults,
    ...(include.with ?? {}),
  } as Record<string, string | number | boolean>;
}

type ResolveConsultationOpts = {
  effectiveParams: Record<string, string | number | boolean>;
  spawnInstructions: Record<string, string>;
  consultations: Record<string, ConsultationFragment>;
  mergedSpawnInstructions: Record<string, string>;
};

/**
 * Deep string substitution: recursively walk an object and replace every
 * `${param}` occurrence in string values with the corresponding param value.
 */
function substituteParams<T>(obj: T, params: Record<string, string | number | boolean>): T {
  if (typeof obj === "string") {
    let result: string = obj;
    for (const [key, value] of Object.entries(params)) {
      result = result.replaceAll(`\${${key}}`, String(value));
    }
    return result as T & string;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteParams(item, params)) as T & unknown[];
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteParams(value, params);
    }
    return result as T;
  }
  return obj;
}

/** Substitute params in spawn instruction text. */
function substituteSpawnInstructions(
  instructions: Record<string, string>,
  params: Record<string, string | number | boolean>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(instructions)) {
    let substituted = text;
    for (const [pKey, pVal] of Object.entries(params)) {
      substituted = substituted.replaceAll(`\${${pKey}}`, String(pVal));
    }
    result[key] = substituted;
  }
  return result;
}

/** Resolve a consultation-type fragment into the consultations and spawn instructions maps. */
export function resolveConsultationFragment(
  definition: FragmentDefinition,
  include: FragmentInclude,
  opts: ResolveConsultationOpts,
): void {
  const { effectiveParams, spawnInstructions, consultations, mergedSpawnInstructions } = opts;
  const consultation: ConsultationFragment = {
    agent: definition.agent!,
    artifact: definition.artifact,
    description: definition.description,
    fragment: definition.fragment,
    min_waves: definition.min_waves,
    role: definition.role!,
    section: definition.section,
    timeout: definition.timeout,
    ...(definition.skip_when !== undefined ? { skip_when: definition.skip_when } : {}),
  };

  const hasParams = Object.keys(effectiveParams).length > 0;
  const substituted = hasParams ? substituteParams(consultation, effectiveParams) : consultation;
  const consultName = include.as ?? definition.fragment;
  consultations[consultName] = substituted;

  mergeSpawnInstructions(definition, include, {
    effectiveParams,
    mergedSpawnInstructions,
    spawnInstructions,
  });
}

/** Apply overrides to fragment states. */
export function applyStateOverrides(
  states: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const [stateId, overrideFields] of Object.entries(overrides)) {
    if (states[stateId]) {
      states[stateId] = {
        ...(states[stateId] as object),
        ...(overrideFields as object),
      } as StateDefinition;
    }
  }
}

/** Rename states when `as:` is used (single-state fragments only). */
export function applyAsRename(
  states: Record<string, unknown>,
  alias: string,
  fragmentName: string,
): Record<string, unknown> {
  const stateEntries = Object.entries(states);
  if (stateEntries.length !== 1) {
    throw new Error(
      `Fragment "${fragmentName}" has ${stateEntries.length} states but "as:" only works with single-state fragments`,
    );
  }
  return { [alias]: stateEntries[0][1] };
}

/** Resolve a regular (non-consultation) fragment's states into the merged states map. */
export function resolveRegularFragment(
  definition: FragmentDefinition,
  include: FragmentInclude,
  effectiveParams: Record<string, string | number | boolean>,
  mergedStates: Record<string, StateDefinition>,
): void {
  if (!definition.states) return;

  const hasParams = Object.keys(effectiveParams).length > 0;
  let states = hasParams
    ? substituteParams(definition.states, effectiveParams)
    : { ...definition.states };

  if (include.overrides) applyStateOverrides(states, include.overrides);
  if (include.as) states = applyAsRename(states, include.as, include.fragment) as typeof states;

  for (const [stateId, stateDef] of Object.entries(states)) {
    if (mergedStates[stateId]) {
      throw new Error(`State ID collision: "${stateId}" already exists`);
    }
    mergedStates[stateId] = stateDef as StateDefinition;
  }
}

type MergeSpawnOpts = {
  effectiveParams: Record<string, string | number | boolean>;
  spawnInstructions: Record<string, string>;
  mergedSpawnInstructions: Record<string, string>;
};

/** Merge spawn instructions from a fragment, applying param substitution and renaming. */
export function mergeSpawnInstructions(
  definition: FragmentDefinition,
  include: FragmentInclude,
  opts: MergeSpawnOpts,
): void {
  const { effectiveParams, spawnInstructions, mergedSpawnInstructions } = opts;
  const hasParams = Object.keys(effectiveParams).length > 0;
  const fragSpawn = hasParams
    ? substituteSpawnInstructions(spawnInstructions, effectiveParams)
    : { ...spawnInstructions };

  for (const [sId, sText] of Object.entries(fragSpawn)) {
    const spawnKey = include.as ? sId.replace(definition.fragment, include.as) : sId;
    mergedSpawnInstructions[spawnKey] = sText;
  }
}
