/**
 * Completeness test for the flow-schema.ts split.
 *
 * Verifies that every value-level export (schemas, constants) from the original
 * `flow-schema.ts` is also present in exactly one of the 3 new schema files.
 *
 * Type-only exports (`export type`) are verified at compile time by TypeScript;
 * they do not exist at runtime and therefore cannot be tested here.
 *
 * This test acts as a regression guard: any schema missed during the split will
 * cause the assertion to fail, catching the omission before importers are migrated.
 */

import { describe, expect, it } from "vitest";

// Original file — the ground truth
import * as originalSchema from "../flow-schema.ts";

// Three new schema files
import * as flowDefSchemas from "../flow-definition-schemas.ts";
import * as boardStateSchemas from "../board-state-schemas.ts";
import * as eventSchemas from "../event-schemas.ts";

// Value-level exports from flow-schema.ts (schemas, constants — not type-only exports)
const ORIGINAL_VALUE_EXPORTS = [
  "STATUS_KEYWORDS",
  "STATUS_ALIASES",
  "StateTypeSchema",
  "StuckWhenSchema",
  "SkipWhenSchema",
  "ContextInjectionSchema",
  "ConsultationsMapSchema",
  "RoleEntrySchema",
  "EffectTypeSchema",
  "EffectSchema",
  "RequiredArtifactSchema",
  "CompeteConfigObjectSchema",
  "CompeteConfigSchema",
  "DebateConfigSchema",
  "GateResultSchema",
  "DiscoveredGateSchema",
  "PostconditionAssertionSchema",
  "PostconditionResultSchema",
  "ViolationSeveritiesSchema",
  "TestResultsSchema",
  "BaselineEvidenceSchema",
  "ToolOverridesSchema",
  "SingleStateSchema",
  "WavePolicySchema",
  "WaveStateSchema",
  "ParallelStateSchema",
  "ParallelPerStateSchema",
  "TerminalStateSchema",
  "StateDefinitionSchema",
  "FragmentIncludeSchema",
  "FlowDefinitionSchema",
  "TypedParamSchema",
  "FragmentParamValueSchema",
  "FragmentStateDefinitionSchema",
  "FragmentDefinitionSchema",
  "ConsultationFragmentSchema",
  "ResolvedFlowSchema",
  "BoardStateStatusSchema",
  "ConsultationResultSchema",
  "WorktreeEntrySchema",
  "WaveResultSchema",
  "StateMetricsSchema",
  "AgentMetricsSchema",
  "ArtifactHistoryEntrySchema",
  "BoardStateEntrySchema",
  "CannotFixItemSchema",
  "ViolationHistoryEntrySchema",
  "FileTestHistoryEntrySchema",
  "StatusHistoryEntrySchema",
  "ProgressHistoryEntrySchema",
  "GateProgressHistoryEntrySchema",
  "HistoryEntrySchema",
  "IterationEntrySchema",
  "BlockedInfoSchema",
  "ConcernEntrySchema",
  "BoardSchema",
  "SessionSchema",
  "TranscriptEntrySchema",
] as const;

// Additional exports that only exist in new files (BaseStateFields, FragmentBaseStateFields
// were unexported in the original but are exported from flow-definition-schemas.ts)
const NEW_ONLY_EXPORTS = ["BaseStateFields", "FragmentBaseStateFields"] as const;

describe("schema-split-completeness", () => {
  it("every value-level export from flow-schema.ts exists in the original file", () => {
    for (const name of ORIGINAL_VALUE_EXPORTS) {
      expect(
        name in originalSchema,
        `Expected "${name}" to exist in flow-schema.ts`,
      ).toBe(true);
    }
  });

  it("every value-level export from flow-schema.ts exists in exactly one new schema file", () => {
    const newFiles = {
      "flow-definition-schemas.ts": flowDefSchemas as Record<string, unknown>,
      "board-state-schemas.ts": boardStateSchemas as Record<string, unknown>,
      "event-schemas.ts": eventSchemas as Record<string, unknown>,
    };

    for (const name of ORIGINAL_VALUE_EXPORTS) {
      const foundIn = Object.entries(newFiles)
        .filter(([, exports]) => name in exports)
        .map(([fileName]) => fileName);

      expect(
        foundIn.length,
        `Expected "${name}" to be in exactly one new file, found in: [${foundIn.join(", ") || "none"}]`,
      ).toBe(1);
    }
  });

  it("flow-definition-schemas.ts exports all flow/state definition schemas", () => {
    const expectedInFlowDef = [
      "STATUS_KEYWORDS",
      "STATUS_ALIASES",
      "StateTypeSchema",
      "StuckWhenSchema",
      "SkipWhenSchema",
      "ContextInjectionSchema",
      "ConsultationsMapSchema",
      "RoleEntrySchema",
      "EffectTypeSchema",
      "EffectSchema",
      "RequiredArtifactSchema",
      "CompeteConfigObjectSchema",
      "CompeteConfigSchema",
      "DebateConfigSchema",
      "GateResultSchema",
      "DiscoveredGateSchema",
      "PostconditionAssertionSchema",
      "PostconditionResultSchema",
      "ViolationSeveritiesSchema",
      "TestResultsSchema",
      "BaselineEvidenceSchema",
      "ToolOverridesSchema",
      "SingleStateSchema",
      "WavePolicySchema",
      "WaveStateSchema",
      "ParallelStateSchema",
      "ParallelPerStateSchema",
      "TerminalStateSchema",
      "StateDefinitionSchema",
      "FragmentIncludeSchema",
      "FlowDefinitionSchema",
      "TypedParamSchema",
      "FragmentParamValueSchema",
      "FragmentStateDefinitionSchema",
      "FragmentDefinitionSchema",
      "ConsultationFragmentSchema",
      "ResolvedFlowSchema",
      // newly exported from this file (were private in flow-schema.ts)
      "BaseStateFields",
      "FragmentBaseStateFields",
    ];

    for (const name of expectedInFlowDef) {
      expect(
        name in (flowDefSchemas as Record<string, unknown>),
        `Expected "${name}" in flow-definition-schemas.ts`,
      ).toBe(true);
    }
  });

  it("board-state-schemas.ts exports all board/session runtime schemas", () => {
    const expectedInBoardState = [
      "BoardStateStatusSchema",
      "ConsultationResultSchema",
      "WorktreeEntrySchema",
      "WaveResultSchema",
      "StateMetricsSchema",
      "AgentMetricsSchema",
      "ArtifactHistoryEntrySchema",
      "BoardStateEntrySchema",
      "CannotFixItemSchema",
      "ViolationHistoryEntrySchema",
      "FileTestHistoryEntrySchema",
      "StatusHistoryEntrySchema",
      "ProgressHistoryEntrySchema",
      "GateProgressHistoryEntrySchema",
      "HistoryEntrySchema",
      "IterationEntrySchema",
      "BlockedInfoSchema",
      "ConcernEntrySchema",
      "BoardSchema",
      "SessionSchema",
    ];

    for (const name of expectedInBoardState) {
      expect(
        name in (boardStateSchemas as Record<string, unknown>),
        `Expected "${name}" in board-state-schemas.ts`,
      ).toBe(true);
    }
  });

  it("event-schemas.ts exports TranscriptEntrySchema", () => {
    expect("TranscriptEntrySchema" in (eventSchemas as Record<string, unknown>)).toBe(true);
  });

  it("BaseStateFields and FragmentBaseStateFields are newly exported from flow-definition-schemas.ts", () => {
    for (const name of NEW_ONLY_EXPORTS) {
      expect(
        name in (flowDefSchemas as Record<string, unknown>),
        `Expected "${name}" to be exported from flow-definition-schemas.ts`,
      ).toBe(true);
    }
  });

  it("no export appears in more than one new schema file", () => {
    const newFiles = {
      "flow-definition-schemas.ts": flowDefSchemas as Record<string, unknown>,
      "board-state-schemas.ts": boardStateSchemas as Record<string, unknown>,
      "event-schemas.ts": eventSchemas as Record<string, unknown>,
    };

    // Collect all exported names across all 3 new files
    const allNewExports = Object.entries(newFiles).flatMap(([fileName, exports]) =>
      Object.keys(exports).map((name) => ({ name, fileName })),
    );

    // Group by name
    const byName = new Map<string, string[]>();
    for (const { name, fileName } of allNewExports) {
      const existing = byName.get(name) ?? [];
      byName.set(name, [...existing, fileName]);
    }

    // Assert no duplicates
    for (const [name, files] of byName.entries()) {
      expect(
        files.length,
        `Export "${name}" appears in multiple files: ${files.join(", ")}`,
      ).toBe(1);
    }
  });
});
