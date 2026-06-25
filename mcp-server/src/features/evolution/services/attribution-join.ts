/**
 * attribution-join.ts — Pure failure→artifact attribution join + hash verification.
 *
 * PURE: no I/O except through the injected seams (readCurrentBody, getTranscriptExcerpt).
 *
 * Two failure kinds (discriminated):
 *   - "review_violation": join on violation.principle_id == artifact.id (inferred, lossy)
 *   - "cliff_event":      join on cliff.step_id == provenance.step_id (exact, clean)
 *
 * test_failure is DEFERRED — no durable test_failure event keyed by step_id exists
 * in the current trace schema (ADR-0023 Revisit-If).
 *
 * Byte-identity trap (PROBE §1): hash verification calls hashContent(rawBody) where
 * rawBody is the UNTRIMMED current file content — NOT a span/prefix form. The recorded
 * content_hash was computed from the pre-disclosure originalContent (same encoding).
 * Hashing a trimmed or prefixed form would yield universal mismatches.
 *
 * Canon principles:
 *   - errors-are-values: lossy paths are typed buckets (unattributed, flagged), never thrown
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed (true only on exact match)
 *   - observable-best-effort: absent inputs → partial output, nothing silently dropped
 *   - no-llm-calls-in-mcp-tools: deterministic equality join + sha256 hashing only
 *   - deep-modules: one small function interface over a rich join
 */

import type { ContextProvenanceSummary } from "@domains/workspaces/context-provenance.ts";
import { hashContent } from "@domains/workspaces/context-provenance.ts";
import type { ReviewViolation } from "@platform/storage/archive/archive-types.ts";
import type { CliffEventRow } from "@platform/storage/drift/cliff-events-dao.ts";
import type {
  AttributedArtifact,
  AttributeFailureResult,
  AttributionConfidence,
  FailureAttribution,
  FlaggedAttribution,
  HashStatus,
  OwningStep,
  TranscriptEvidence,
  UnattributedViolation,
} from "./attribution-types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AttributeFailuresInput = {
  provenance: ContextProvenanceSummary[];
  violations: ReviewViolation[];
  cliffEvents: CliffEventRow[];
  /** Injected seam: read the CURRENT raw artifact body from disk. Return null on missing. */
  readCurrentBody: (path: string) => string | null;
  /** Optional seam: get transcript excerpt for (stepId, artifactId). */
  getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null;
};

/**
 * attributeFailures — pure join over provenance × failures.
 *
 * Never throws. Lossy paths emit typed buckets.
 */
export function attributeFailures(input: AttributeFailuresInput): AttributeFailureResult {
  const { provenance, violations, cliffEvents, readCurrentBody, getTranscriptExcerpt } = input;

  const attributions: FailureAttribution[] = [];
  const unattributed: UnattributedViolation[] = [];
  const flagged: FlaggedAttribution[] = [];

  const violationChecks = attributeViolations({
    attributions,
    flagged,
    getTranscriptExcerpt,
    provenance,
    readCurrentBody,
    unattributed,
    violations,
  });

  const cliffChecks = attributeCliffs({
    attributions,
    cliffEvents,
    flagged,
    getTranscriptExcerpt,
    provenance,
    readCurrentBody,
  });

  return {
    attributions,
    flagged,
    meta: {
      hash_checks: violationChecks + cliffChecks,
      provenance_steps: provenance.length,
      violations_seen: violations.length,
    },
    unattributed,
  };
}

// ---------------------------------------------------------------------------
// review_violation attribution
// ---------------------------------------------------------------------------

type ViolationCtx = {
  attributions: FailureAttribution[];
  flagged: FlaggedAttribution[];
  getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null;
  provenance: ContextProvenanceSummary[];
  readCurrentBody: (path: string) => string | null;
  unattributed: UnattributedViolation[];
  violations: ReviewViolation[];
};

/** Returns the number of hash checks performed. */
function attributeViolations(ctx: ViolationCtx): number {
  const provenanceEmpty = ctx.provenance.length === 0;
  let checks = 0;

  for (const violation of ctx.violations) {
    const candidates = findArtifactCandidates(ctx.provenance, violation.principle_id);

    if (candidates.length === 0) {
      ctx.unattributed.push({
        reason: provenanceEmpty ? "no_provenance" : "no_in_context_artifact",
        violation,
      });
      continue;
    }

    const { deduplicatedArtifact, owningSteps } = extractOwningInfo(candidates);
    checks += 1;

    const currentBody = ctx.readCurrentBody(deduplicatedArtifact.path);
    const { attributedArtifact, flagEntry } = verifyArtifact(deduplicatedArtifact, currentBody);
    if (flagEntry !== null) ctx.flagged.push(flagEntry);

    const transcript = collectTranscriptEvidence(
      owningSteps,
      deduplicatedArtifact.id,
      ctx.getTranscriptExcerpt,
    );
    const ambiguous = owningSteps.length > 1;
    const confidence = deriveConfidence({
      ambiguous,
      failureKind: "review_violation",
      hashVerified: attributedArtifact.hash_verified,
      hasTranscript: transcript.length > 0,
    });
    const hypothesis = buildViolationHypothesis(
      deduplicatedArtifact.id,
      owningSteps,
      violation.principle_id,
    );

    ctx.attributions.push({
      ambiguous,
      attributed_violations: [violation],
      confidence,
      failure_kind: "review_violation",
      hypothesis,
      join_basis: "principle_id==artifact_id",
      owning_steps: owningSteps,
      presence_in_context: true,
      target_artifact: attributedArtifact,
      transcript_evidence: transcript,
    });
  }

  return checks;
}

/** Build hypothesis string for a review_violation attribution. */
function buildViolationHypothesis(
  artifactId: string,
  owningSteps: OwningStep[],
  principleId: string,
): string {
  const agentNames = owningSteps.map((s) => s.agent_name).join("/");
  const stepIds = owningSteps
    .filter((s) => s.step_id !== null)
    .map((s) => s.step_id ?? "unknown")
    .join(", ");
  const stepPart =
    stepIds.length > 0 ? ` (step${owningSteps.length > 1 ? "s" : ""} ${stepIds})` : "";
  return `Rule '${artifactId}' was in ${agentNames}'s context${stepPart} when violation of ${principleId} was observed`;
}

// ---------------------------------------------------------------------------
// cliff_event attribution
// ---------------------------------------------------------------------------

type CliffCtx = {
  attributions: FailureAttribution[];
  cliffEvents: CliffEventRow[];
  flagged: FlaggedAttribution[];
  getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null;
  provenance: ContextProvenanceSummary[];
  readCurrentBody: (path: string) => string | null;
};

/** Returns the number of hash checks performed. */
function attributeCliffs(ctx: CliffCtx): number {
  let checks = 0;

  for (const cliff of ctx.cliffEvents) {
    const matchingProv = ctx.provenance.find((p) => p.step_id === cliff.step_id);
    if (matchingProv === undefined) continue; // no provenance for this cliff step

    const owningStep: OwningStep = {
      agent_id: matchingProv.agent_id,
      agent_name: matchingProv.agent_name,
      step_id: matchingProv.step_id,
    };

    for (const rawArtifact of matchingProv.artifacts) {
      checks += 1;
      const currentBody = ctx.readCurrentBody(rawArtifact.path);
      const { attributedArtifact, flagEntry } = verifyArtifact(rawArtifact, currentBody);
      if (flagEntry !== null) ctx.flagged.push(flagEntry);

      const transcript = collectTranscriptEvidence(
        [owningStep],
        rawArtifact.id,
        ctx.getTranscriptExcerpt,
      );
      const confidence = deriveConfidence({
        ambiguous: false,
        failureKind: "cliff_event",
        hashVerified: attributedArtifact.hash_verified,
        hasTranscript: transcript.length > 0,
      });
      const hypothesis = `Artifact '${rawArtifact.id}' was in ${matchingProv.agent_name}'s context (step ${cliff.step_id}) when the agent write-cliff was detected`;

      ctx.attributions.push({
        ambiguous: false,
        attributed_violations: [],
        confidence,
        failure_kind: "cliff_event",
        hypothesis,
        join_basis: "cliff_step_id",
        owning_steps: [owningStep],
        presence_in_context: true,
        target_artifact: attributedArtifact,
        transcript_evidence: transcript,
      });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type RawArtifact = {
  kind: "rule" | "ref" | "primer" | "template";
  id: string;
  path: string;
  content_hash: string;
  char_span: [number, number] | null;
  source?: "sidecar";
  sidecar_path?: string;
};

type ArtifactCandidate = {
  artifact: RawArtifact;
  step: ContextProvenanceSummary;
};

/** Find all (artifact, step) pairs where artifact.id === principleId. */
function findArtifactCandidates(
  provenance: ContextProvenanceSummary[],
  principleId: string,
): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  for (const step of provenance) {
    for (const artifact of step.artifacts) {
      if (artifact.id === principleId) {
        candidates.push({ artifact, step });
      }
    }
  }
  return candidates;
}

/** Extract deduplicated artifact + owning steps from candidates. */
function extractOwningInfo(candidates: ArtifactCandidate[]): {
  deduplicatedArtifact: RawArtifact;
  owningSteps: OwningStep[];
} {
  const deduplicatedArtifact = candidates[0].artifact;
  const owningSteps: OwningStep[] = candidates.map((c) => ({
    agent_id: c.step.agent_id,
    agent_name: c.step.agent_name,
    step_id: c.step.step_id,
  }));
  return { deduplicatedArtifact, owningSteps };
}

/** Hash-verify the artifact body. Fail-closed: hash_verified true ONLY on exact match. */
function verifyArtifact(
  artifact: RawArtifact,
  currentBody: string | null,
): { attributedArtifact: AttributedArtifact; flagEntry: FlaggedAttribution | null } {
  const { hashStatus, hashVerified, flagEntry } = computeHashResult(artifact, currentBody);

  const attributedArtifact: AttributedArtifact = {
    char_span: artifact.char_span,
    content_hash: artifact.content_hash,
    hash_status: hashStatus,
    hash_verified: hashVerified,
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    span_available: artifact.char_span !== null,
  };

  return { attributedArtifact, flagEntry };
}

/** Compute hash verification result from raw body. */
function computeHashResult(
  artifact: Pick<RawArtifact, "id" | "path" | "content_hash">,
  currentBody: string | null,
): { hashStatus: HashStatus; hashVerified: boolean; flagEntry: FlaggedAttribution | null } {
  if (currentBody === null) {
    return {
      flagEntry: { artifact_id: artifact.id, path: artifact.path, reason: "artifact_missing" },
      hashStatus: "artifact_missing",
      hashVerified: false,
    };
  }
  // BYTE-IDENTITY: hash the RAW current body (not trimmed or prefixed)
  const currentHash = hashContent(currentBody);
  if (currentHash === artifact.content_hash) {
    return { flagEntry: null, hashStatus: "verified", hashVerified: true };
  }
  return {
    flagEntry: { artifact_id: artifact.id, path: artifact.path, reason: "hash_mismatch" },
    hashStatus: "mismatch",
    hashVerified: false,
  };
}

/** Collect optional transcript evidence for the owning steps. */
function collectTranscriptEvidence(
  owningSteps: OwningStep[],
  artifactId: string,
  getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null,
): TranscriptEvidence[] {
  if (getTranscriptExcerpt === undefined) return [];
  const evidence: TranscriptEvidence[] = [];
  for (const step of owningSteps) {
    if (step.step_id === null) continue;
    const excerpt = getTranscriptExcerpt(step.step_id, artifactId);
    if (excerpt !== null) evidence.push(excerpt);
  }
  return evidence;
}

/** Derive confidence deterministically from join basis + verification status. */
function deriveConfidence(input: {
  failureKind: "review_violation" | "cliff_event";
  hashVerified: boolean;
  ambiguous: boolean;
  hasTranscript: boolean;
}): AttributionConfidence {
  const { failureKind, hashVerified, ambiguous, hasTranscript } = input;
  if (!hashVerified) return "low";
  if (failureKind === "cliff_event") return "high";
  // review_violation: inferred join
  if (!ambiguous && hasTranscript) return "high";
  return "medium";
}
