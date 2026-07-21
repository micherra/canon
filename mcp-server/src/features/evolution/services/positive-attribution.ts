/**
 * positive-attribution.ts — Pure honored→artifact attribution join. The positive
 * counterpart to attribution-join.ts's negative (violation) join.
 *
 * PURE: no I/O except through the injected readCurrentBody / resolveCorpusArtifact seams.
 *
 * Join: honoredId == provenance artifact.id — structurally symmetric with the negative
 * path's `violation.principle_id == artifact.id` join (PROBE-FINDINGS Q1). The one real
 * gap is a read-time parse: `honored[]` entries are markdown-wrapped strings
 * (`- **{principle-id}**` — the trailing `: {how honored}` the template prescribes is
 * present on only 20.4% of real citations), not bare ids — extractHonoredSection
 * (run-summary-extractors.ts) deliberately does NOT parse them (changing it would break
 * determinism against already-archived strings, ADR-0051). The bare-id parse lives here,
 * at read time — which makes a fix to it retroactive across every archived build with no
 * backfill (ADR-0059).
 *
 * Byte-identity trap (mirrors attribution-join.ts PROBE §1): hash verification calls
 * hashContent(rawBody) where rawBody is the UNTRIMMED current file content — NOT a
 * span/prefix form.
 *
 * Asymmetry with the negative path (by design): a hash mismatch here is flagged
 * WITHOUT also producing an attribution (the negative path still attributes at lower
 * confidence). An honored-but-since-drifted artifact should not boost a principle's
 * trust score — see Tests to write in the task plan.
 *
 * Two-edge join (ADR-0062, Bug-1 part (d)): most historical honored citations have no
 * recorded in-context provenance at all — the provenance recorder postdates most of the
 * corpus (PROBE-FINDINGS). Recording provenance going forward can never retroactively fix
 * that. Instead, a citation with no provenance candidate falls back to resolving the id
 * against the CURRENT corpus (the shared resolver, `corpus-artifact-lookup.ts`) via the
 * optional `resolveCorpusArtifact` seam. The fallback NEVER fabricates a presence claim —
 * `presence_in_context: false`, `hash_status: "unrecorded"` (no hash was ever recorded to
 * verify against), `owning_steps: []` (nobody to attribute corroboration to). This is
 * read-time and retroactive by construction (derive-on-read, ADR-0051/0057) — zero
 * archive writes, applies uniformly to every already-archived build the moment this code
 * ships.
 *
 * Canon principles:
 *   - errors-are-values: lossy paths are typed buckets (unattributed, flagged), never thrown
 *   - validate-at-trust-boundaries: content_hash re-check is fail-closed (true only on exact match)
 *   - no-llm-calls-in-mcp-tools: deterministic equality join + regex parse + sha256 hashing only
 *   - deep-modules: one small function interface (attributeHonored) over the join
 *
 * No-LLM verification: grep -niE 'anthropic|claude|messages.create|model:|Date.now|Math.random'
 * positive-attribution.ts -> zero hits (except this comment).
 */

import type {
  AssembledArtifact,
  ContextProvenanceSummary,
} from "@domains/workspaces/context-provenance.ts";
import { hashContent } from "@domains/workspaces/context-provenance.ts";
import { isPrincipleIdShaped } from "../../../platform/storage/archive/run-summary-extractors.ts";
import type {
  AttributedArtifact,
  FlaggedAttribution,
  HashStatus,
  OwningStep,
} from "./attribution-types.ts";
import type { CorpusArtifactLookup } from "./corpus-artifact-lookup.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A raw honored line as extracted by extractHonoredSection (still markdown-wrapped). */
export type HonoredEntry = {
  raw: string;
  step_id: string | null;
};

/**
 * A single honored->artifact attribution.
 *
 * Vocabulary invariant: `hypothesis` uses presence/hypothesis vocabulary ONLY.
 * "caused"/"causes"/"honored-because" are NEVER used. `presence_in_context: true` is
 * asserted ONLY for the provenance edge — the fallback edge asserts citation +
 * current-corpus resolution, nothing more (`presence_in_context: false`).
 */
export type PositiveAttribution = {
  /** Hypothesis statement. NEVER uses "caused"/"causes"/"honored-because". */
  hypothesis: string;
  /** The artifact that was in context (or resolved from the corpus) and is the attribution target. */
  target_artifact: AttributedArtifact;
  /** Steps whose context held the matching artifact. Empty for a corpus_fallback edge. */
  owning_steps: OwningStep[];
  /** True ONLY for the provenance edge — the artifact was present in context during the
   *  build. The corpus_fallback edge never fabricates this claim. */
  presence_in_context: boolean;
  /** How the join was performed — mirrors the negative path's join_basis convention. */
  join_basis: "in_context_provenance" | "corpus_fallback";
};

/** A honored line that could not be attributed to any in-context OR on-disk artifact. */
export type UnattributedHonored = {
  honored: HonoredEntry;
  /** "unparseable_honored" — no bolded, id-shaped `**id**` prefix (the colon is optional).
   *  "no_corpus_artifact" — parsed id has no matching provenance artifact AND is not
   *  resolvable against the current corpus (or no resolveCorpusArtifact seam was given). */
  reason: "unparseable_honored" | "no_corpus_artifact";
};

/** Full result shape for attributeHonored. */
export type AttributeHonoredResult = {
  /** Successful attributions — artifact was in context and hash check passed. */
  attributions: PositiveAttribution[];
  /** Honored lines that could not be joined to any in-context artifact. */
  unattributed: UnattributedHonored[];
  /** Artifacts where hash verification failed (drifted or missing) — never attributed. */
  flagged: FlaggedAttribution[];
  /** Processing metadata for observability. */
  meta: {
    provenance_steps: number;
    honored_seen: number;
    hash_checks: number;
  };
};

type AttributeHonoredInput = {
  provenance: ContextProvenanceSummary[];
  honored: HonoredEntry[];
  /** Injected seam: read the CURRENT raw artifact body from disk. Return null on missing. */
  readCurrentBody: (path: string) => string | null;
  /** Optional seam: resolve an id against the current corpus (shared resolver,
   *  corpus-artifact-lookup.ts). Only consulted when no provenance candidate exists —
   *  see the module header's "Two-edge join" section. Omitted -> prior behavior
   *  byte-for-byte (every provenance miss becomes no_corpus_artifact). */
  resolveCorpusArtifact?: CorpusArtifactLookup;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * attributeHonored — pure join over provenance x honored lines.
 *
 * Never throws. Lossy paths emit typed buckets.
 */
export function attributeHonored(input: AttributeHonoredInput): AttributeHonoredResult {
  const { provenance, honored, readCurrentBody, resolveCorpusArtifact } = input;

  const attributions: PositiveAttribution[] = [];
  const unattributed: UnattributedHonored[] = [];
  const flagged: FlaggedAttribution[] = [];
  let hashChecks = 0;

  for (const entry of honored) {
    const parsedId = parseHonoredId(entry.raw);
    if (parsedId === null) {
      unattributed.push({ honored: entry, reason: "unparseable_honored" });
      continue;
    }

    const candidates = findArtifactCandidates(provenance, parsedId);
    if (candidates.length === 0) {
      const fallback = resolveCorpusArtifact?.(parsedId) ?? null;
      if (fallback === null) {
        unattributed.push({ honored: entry, reason: "no_corpus_artifact" });
        continue;
      }
      attributions.push(buildFallbackAttribution(parsedId, fallback));
      continue;
    }

    const { deduplicatedArtifact, owningSteps } = extractOwningInfo(candidates);
    hashChecks += 1;
    const currentBody = readCurrentBody(deduplicatedArtifact.path);
    const { attributedArtifact, flagEntry } = verifyArtifact(deduplicatedArtifact, currentBody);

    if (flagEntry !== null) {
      // Hash mismatch/missing -> flagged, NOT attributed (asymmetric with the negative
      // path by design: a drifted honored artifact should not boost trust). This branch
      // only runs when a provenance candidate WAS found (candidates.length > 0), so it
      // is structurally disjoint from the corpus-fallback branch above — a recorded-but-
      // drifted provenance artifact can never be silently downgraded into a fallback
      // attribution.
      flagged.push(flagEntry);
      continue;
    }

    attributions.push({
      hypothesis: buildHonoredHypothesis(deduplicatedArtifact.id, owningSteps),
      join_basis: "in_context_provenance",
      owning_steps: owningSteps,
      presence_in_context: true,
      target_artifact: attributedArtifact,
    });
  }

  return {
    attributions,
    flagged,
    meta: {
      hash_checks: hashChecks,
      honored_seen: honored.length,
      provenance_steps: provenance.length,
    },
    unattributed,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors attribution-join.ts's private helpers, positive-only shape)
// ---------------------------------------------------------------------------

/**
 * Matches a bolded principle id at the start of an honored bullet. The colon and any
 * trailing description are optional — 74% of real reviews write the bare `**id**` form,
 * and requiring the colon parsed only 20.4% of the archived corpus.
 */
const HONORED_ID_PATTERN = /^\s*\*\*([^*]+)\*\*/;

/**
 * Parse the bare principle id from a `**{id}**` honored line. Returns null if unparseable.
 *
 * The charset guard is what makes the relaxed pattern safe: without it the pattern matches
 * ANY bold span, which over the real corpus yields 79 prose tokens as principle ids
 * ("Robust git-failure degradation", "noExcessiveLinesPerFile"). Recording those is
 * fabrication. The guard is imported, never re-declared — one closed domain, one writer.
 */
function parseHonoredId(raw: string): string | null {
  const match = raw.match(HONORED_ID_PATTERN);
  const id = match?.[1]?.trim();
  return id !== undefined && isPrincipleIdShaped(id) ? id : null;
}

type ArtifactCandidate = {
  artifact: AssembledArtifact;
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
  deduplicatedArtifact: AssembledArtifact;
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
  artifact: AssembledArtifact,
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
  artifact: Pick<AssembledArtifact, "id" | "path" | "content_hash">,
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

/** Build hypothesis string for an honored attribution. Presence vocabulary only. */
function buildHonoredHypothesis(artifactId: string, owningSteps: OwningStep[]): string {
  const agentNames = owningSteps.map((s) => s.agent_name).join("/");
  const stepIds = owningSteps
    .filter((s) => s.step_id !== null)
    .map((s) => s.step_id ?? "unknown")
    .join(", ");
  const stepPart =
    stepIds.length > 0 ? ` (step${owningSteps.length > 1 ? "s" : ""} ${stepIds})` : "";
  return `Rule '${artifactId}' was present in ${agentNames}'s context${stepPart} when it was marked honored`;
}

/**
 * Build a corpus-fallback attribution — no provenance candidate exists, but the id
 * resolves against the current corpus. NEVER fabricates a presence claim: `hash_status`
 * is "unrecorded" (nothing was ever recorded to verify against, distinct from a
 * mismatch/missing check that DID have a recorded hash), `owning_steps` is empty (no
 * step to attribute corroboration to), `char_span`/`span_available` are the doc-
 * comment-documented "blanked/no span" shape. `kind: "rule"` is the pre-existing safe
 * fallback kind (see classifyArtifact) — the positive path never attributes agent-defs
 * regardless of the resolved artifact_class, so outcome-attribution.ts's Finding-4
 * comment (positive path can't be agent-def) stays valid.
 */
function buildFallbackAttribution(
  parsedId: string,
  fallback: { path: string },
): PositiveAttribution {
  return {
    hypothesis: buildFallbackHypothesis(parsedId),
    join_basis: "corpus_fallback",
    owning_steps: [],
    presence_in_context: false,
    target_artifact: {
      char_span: null,
      content_hash: "",
      hash_status: "unrecorded",
      hash_verified: false,
      id: parsedId,
      kind: "rule",
      path: fallback.path,
      span_available: false,
    },
  };
}

/** Build hypothesis string for a corpus-fallback attribution. Citation vocabulary only. */
function buildFallbackHypothesis(artifactId: string): string {
  return `Rule '${artifactId}' was cited as honored; no in-context provenance was recorded — resolved against the current corpus`;
}
