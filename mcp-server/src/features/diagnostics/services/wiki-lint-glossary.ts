/**
 * Glossary self-consistency check for CONTEXT.md.
 *
 * Parses H2 headings from a markdown file and flags two collision kinds:
 * - exact-duplicate: same normalized (base, qualifier) pair appears ≥2 times
 * - naked-vs-qualified: a base term appears both naked and with a defined qualifier
 *
 * Allowed (NOT flagged): same base with ≥2 DISTINCT defined qualifiers and no naked occurrence.
 *
 * Canon principles:
 * - pure-io-service-split: pure function, no I/O; file content is pre-loaded by the caller
 * - functions-do-one-thing: helpers each do exactly one thing (parse, group, detect)
 * - errors-are-values: no throws; empty content returns []
 * - naming-reveals-intent: type kind names ("exact-duplicate", "naked-vs-qualified") are explicit
 */

// ---- Types ----

export type GlossaryConsistencyFinding = {
  kind: "exact-duplicate" | "naked-vs-qualified";
  line_numbers: number[];
  term: string;
};

// ---- Internal types ----

type HeadingEntry = {
  baseTerm: string;
  key: string;
  lineNumber: number;
  qualifier: string | undefined;
};

// ---- Helpers ----

/** Normalize a term string: lowercase, collapse whitespace, trim. */
function normalizeTerm(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Parse all H2 headings from markdown content.
 * Returns one HeadingEntry per `## ` line, 1-based line numbers.
 */
function parseHeadings(content: string): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("## ")) continue;
    const heading = line.slice(3).trim();
    const qualifierMatch = /^(.*?)\s*\((.*)\)\s*$/.exec(heading);
    let baseTerm: string;
    let qualifier: string | undefined;
    if (qualifierMatch) {
      baseTerm = normalizeTerm(qualifierMatch[1] ?? "");
      qualifier = normalizeTerm(qualifierMatch[2] ?? "");
    } else {
      baseTerm = normalizeTerm(heading);
      qualifier = undefined;
    }
    const key = `${baseTerm}|${qualifier ?? ""}`;
    entries.push({ baseTerm, key, lineNumber: i + 1, qualifier });
  }
  return entries;
}

/** Group heading entries by their base term. */
function groupByBase(entries: HeadingEntry[]): Map<string, HeadingEntry[]> {
  const groups = new Map<string, HeadingEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.baseTerm) ?? [];
    group.push(entry);
    groups.set(entry.baseTerm, group);
  }
  return groups;
}

/** Detect exact-duplicate findings within a group sharing the same base term. */
function detectExactDuplicates(entries: HeadingEntry[]): GlossaryConsistencyFinding[] {
  const byKey = new Map<string, HeadingEntry[]>();
  for (const entry of entries) {
    const group = byKey.get(entry.key) ?? [];
    group.push(entry);
    byKey.set(entry.key, group);
  }
  const findings: GlossaryConsistencyFinding[] = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    findings.push({
      kind: "exact-duplicate",
      line_numbers: group.map((e) => e.lineNumber),
      term: group[0].baseTerm,
    });
  }
  return findings;
}

/**
 * Detect naked-vs-qualified findings within a group sharing the same base term.
 *
 * Flagged when: at least one entry is naked (qualifier === undefined) AND at least
 * one entry has a defined qualifier.
 *
 * Not flagged when: all entries have defined qualifiers (allowed disambiguation).
 */
function detectNakedVsQualified(entries: HeadingEntry[]): GlossaryConsistencyFinding[] {
  const naked = entries.filter((e) => e.qualifier === undefined);
  const qualified = entries.filter((e) => e.qualifier !== undefined);
  if (naked.length === 0 || qualified.length === 0) return [];
  return [
    {
      kind: "naked-vs-qualified",
      line_numbers: [...naked, ...qualified].map((e) => e.lineNumber),
      term: entries[0].baseTerm,
    },
  ];
}

// ---- Public API ----

/**
 * Check a markdown file's H2 headings for glossary self-consistency.
 *
 * Parses every `## ` line; ignores H1 and non-heading lines.
 * For each heading: strips `## `, splits base/qualifier via regex,
 * normalizes (lowercase + collapse whitespace + trim), records 1-based line number.
 *
 * Detection:
 * - exact-duplicate: same normalized (base, qualifier) key ≥2×
 * - naked-vs-qualified: base appears both naked and with a defined qualifier
 * - allowed (not flagged): same base, ≥2 distinct defined qualifiers, no naked occurrence
 *
 * Pure: no I/O. Missing or empty content returns [].
 */
export function checkGlossaryConsistency(file: {
  content: string;
  path: string;
}): GlossaryConsistencyFinding[] {
  const entries = parseHeadings(file.content);
  if (entries.length === 0) return [];

  const groups = groupByBase(entries);
  const findings: GlossaryConsistencyFinding[] = [];

  for (const [, groupEntries] of groups) {
    // exact-duplicate: detect once and emit
    const dupFindings = detectExactDuplicates(groupEntries);
    findings.push(...dupFindings);

    // naked-vs-qualified: always evaluate independently of exact-duplicate presence.
    // Avoid literal double-reporting: if a line is already in an exact-duplicate finding,
    // remove it from the naked-vs-qualified line list. Emit the finding only if at least
    // one line remains (the qualified heading(s) are never exact-duplicates, so they
    // survive the filter and preserve the collision signal).
    const dupLines = new Set(dupFindings.flatMap((f) => f.line_numbers));
    const nvqFindings = detectNakedVsQualified(groupEntries);
    for (const nvq of nvqFindings) {
      const dedupedLines = nvq.line_numbers.filter((ln) => !dupLines.has(ln));
      if (dedupedLines.length > 0) {
        findings.push({ ...nvq, line_numbers: dedupedLines });
      }
    }
  }

  return findings;
}
