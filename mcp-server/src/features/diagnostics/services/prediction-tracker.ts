/**
 * Prediction Tracker — Wave 2 write path.
 *
 * Records what signals were injected for which files (a "prediction") so that
 * reconcilePredictions() can later verify whether the predicted violations
 * actually occurred in the subsequent Canon review.
 *
 * Fail-open by design: prediction tracking must never prevent signal injection
 * from completing. Any error (DB unavailable, schema missing, serialization
 * failure) is silently swallowed.
 *
 * Single responsibility: this file records predictions. compileSignals() in
 * signal-compiler.ts reads and assembles signals. Different responsibilities,
 * different functions, different files.
 */

import { randomUUID } from "node:crypto";
import type { DriftDbSignals, PredictionRow } from "@platform/storage/drift/drift-db-signals.ts";
import type { FileSignals } from "./signal-compiler.ts";

// ---- Types ----

/**
 * Input to recordPrediction().
 * filePaths and compiledSignals come directly from the get_context signals pathway.
 */
export type RecordPredictionInput = {
  filePaths: string[];
  compiledSignals: FileSignals[];
  workspace?: string;
  flowId?: string;
};

/**
 * Structural interface for reconciliation — avoids write-review importing
 * from platform/storage/drift directly (bounded-context-boundaries).
 *
 * DriftDbSignals satisfies this interface via structural typing.
 */
export type PredictionReconciler = {
  getUnresolvedPredictions(): PredictionRow[];
  resolvePrediction(input: { prediction_id: string; resolved_at: string; outcome: string }): void;
};

/** A single per-pair outcome in the reconciliation result. */
export type PairOutcome = {
  file_path: string;
  principle_id: string;
  predicted: boolean;
  actual: boolean;
};

/** Input for reconcilePredictions(). */
export type ReconcilePredictionsInput = {
  /** Files included in the review. */
  reviewedFiles: string[];
  /** Violations found by the reviewer. */
  violations: Array<{ file_path?: string; principle_id: string }>;
};

// ---- Internal helpers ----

/**
 * Extract unique principle IDs from compiled signals.
 *
 * Parses the signal text for violation_history signals in the format:
 *   Principle "principle-id" has been violated...
 *
 * Returns deduplicated array preserving insertion order.
 * Returns empty array when no violation_history signals exist or none match
 * the expected format.
 */
function extractPrincipleIds(compiledSignals: FileSignals[]): string[] {
  const ids = new Set<string>();
  for (const fs of compiledSignals) {
    for (const signal of fs.signals) {
      if (signal.type === "violation_history") {
        // Format coupling: must match the text format produced by scoreViolationHistory() in signal-compiler.ts
        // Extract from format: 'Principle "principle-id" has been violated...'
        const match = signal.text.match(/^Principle "([^"]+)"/);
        if (match) ids.add(match[1]);
      }
    }
  }
  return [...ids];
}

// ---- Public API ----

/**
 * Record a prediction — what signals were injected for which files.
 *
 * Called after compileSignals() in the get_context signals pathway.
 * The call is fire-and-forget from the caller's perspective.
 *
 * Skips recording when:
 * - compiledSignals is empty (no signals were compiled)
 * - All signal arrays are empty (no actual signals for any file)
 * - No principle IDs can be extracted from signals (nothing meaningful to predict)
 *
 * Fail-open: any error is silently caught and undefined is returned.
 * Prediction recording failures must never prevent signal injection from completing.
 *
 * @returns prediction_id (UUID) if recorded successfully, undefined on skip or failure
 */
export function recordPrediction(
  input: RecordPredictionInput,
  driftDbSignals: DriftDbSignals,
): string | undefined {
  try {
    // Skip recording if no signals were compiled (nothing to predict)
    const signalsWithData = input.compiledSignals.filter((fs) => fs.signals.length > 0);
    if (signalsWithData.length === 0) return undefined;

    // Extract unique principle IDs from violation_history signals
    const principleIds = extractPrincipleIds(input.compiledSignals);
    if (principleIds.length === 0) return undefined;

    const predictionId = randomUUID();
    const now = new Date().toISOString();

    driftDbSignals.insertPrediction({
      file_paths: JSON.stringify(input.filePaths),
      flow_id: input.flowId ?? null,
      prediction_id: predictionId,
      principle_ids: JSON.stringify(principleIds),
      signals_json: JSON.stringify(signalsWithData),
      timestamp: now,
      workspace: input.workspace ?? null,
    });

    return predictionId;
  } catch {
    // Fail-open: prediction recording failures are silently ignored.
    // Prediction tracking must never prevent signal injection from completing.
    return undefined;
  }
}

// ---- reconcilePredictions ----

/** Parse a prediction's JSON columns. Returns null when either column is corrupt. */
function parsePredictionColumns(
  prediction: PredictionRow,
): { filePaths: string[]; principleIds: string[] } | null {
  try {
    const filePaths = JSON.parse(prediction.file_paths) as string[];
    const principleIds = JSON.parse(prediction.principle_ids) as string[];
    return { filePaths, principleIds };
  } catch {
    return null;
  }
}

/** Build per-pair outcome array for overlapping (file, principle) combinations. */
function buildPairOutcomes(
  overlapping: string[],
  principleIds: string[],
  actualViolationKeys: Set<string>,
): PairOutcome[] {
  const pairs: PairOutcome[] = [];
  for (const filePath of overlapping) {
    for (const principleId of principleIds) {
      pairs.push({
        actual: actualViolationKeys.has(`${filePath}::${principleId}`),
        file_path: filePath,
        predicted: true,
        principle_id: principleId,
      });
    }
  }
  return pairs;
}

/**
 * Reconcile unresolved predictions against actual review violations.
 *
 * Called after review persistence in write-review.ts. Fire-and-forget:
 * errors are silently caught and must never prevent the review from completing.
 *
 * Algorithm:
 * 1. Get all unresolved predictions
 * 2. For each prediction, check if its file_paths overlap with reviewedFiles
 * 3. For overlapping predictions, compare (file_path, principle_id) pairs
 *    against actual violations
 * 4. Mark prediction resolved with per-pair outcome JSON
 *
 * Fail-open: any error — DB failure, corrupt JSON, resolution error — is
 * silently caught. The review itself was already written successfully.
 *
 * @param input - reviewed files and actual violations from the review
 * @param reconciler - structural interface satisfied by DriftDbSignals
 */
export function reconcilePredictions(
  input: ReconcilePredictionsInput,
  reconciler: PredictionReconciler,
): void {
  try {
    const unresolved = reconciler.getUnresolvedPredictions();
    if (unresolved.length === 0) return;

    // Build a Set of actual violations for O(1) lookup: "file_path::principle_id"
    const actualViolationKeys = new Set<string>();
    for (const v of input.violations) {
      if (v.file_path) {
        actualViolationKeys.add(`${v.file_path}::${v.principle_id}`);
      }
    }

    const reviewedFileSet = new Set(input.reviewedFiles);
    const now = new Date().toISOString();

    for (const prediction of unresolved) {
      const parsed = parsePredictionColumns(prediction);
      if (!parsed) continue; // Corrupt JSON — skip

      const overlapping = parsed.filePaths.filter((fp) => reviewedFileSet.has(fp));
      if (overlapping.length === 0) continue;

      const pairs = buildPairOutcomes(overlapping, parsed.principleIds, actualViolationKeys);
      reconciler.resolvePrediction({
        outcome: JSON.stringify({ pairs }),
        prediction_id: prediction.prediction_id,
        resolved_at: now,
      });
    }
  } catch {
    // Fail-open: reconciliation failures are silently ignored.
    // The review itself was already written successfully.
  }
}
