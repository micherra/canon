/**
 * review-format-contract.test.ts — the two-directional review-format contract gate (AC#6).
 *
 * Two bugs motivated this gate, and they failed in OPPOSITE directions:
 *   F1  template <-> parser disagreed.
 *   Bug 2  template and parser AGREED with each other while REALITY drifted from both —
 *          the template said `- **{id}**: {how honored}`, the parser required `**{id}**:`,
 *          and 74% of real reviews wrote the bare `**id**` form. A template<->parser parity
 *          gate would have passed GREEN the entire time Bug 2 was live.
 *
 * So the gate asserts both directions:
 *   Direction A — templates/review.md -> parser: the shipped parser can read the format the
 *                 template tells reviewers to write. Reads the LIVE template file, so editing
 *                 it into an unparseable shape fails this suite.
 *   Direction B — checked-in corpus fixture -> parser: every shape MEASURED in the real
 *                 archived corpus still parses to its expected id.
 *
 * The fixture is CHECKED IN and this file references `.canon/` nowhere. A gate that scanned
 * `.canon/history/` (gitignored, absent in CI) would pass locally and no-op silently in CI —
 * the same silent-failure shape as the bug under repair. A hygiene test below pins that.
 *
 * Canon principles:
 *   - single-source-of-truth: invokes the real parseReviewFile / attributeHonored and reads
 *     the real templates/review.md. Never re-implements parsing; never hard-codes the
 *     template's header as a literal to compare against.
 *   - tests-are-deterministic: checked-in fixture, no .canon/ reads, no network, no Date.now(),
 *     module-relative paths (CWD-independent).
 *   - validate-at-trust-boundaries: the prose entries assert the charset guard is enforced
 *     end-to-end through the shipped parsers, not just unit-tested in isolation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ContextProvenanceSummary } from "../../../domains/workspaces/context-provenance.ts";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import {
  attributeHonored,
  type HonoredEntry,
} from "../../../features/evolution/services/positive-attribution.ts";
import { isPrincipleIdShaped, parseReviewFile } from "./run-summary-extractors.ts";

// Module-relative, never process.cwd(): src/platform/storage/archive -> repo root is 5 up.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(moduleDir, "..", "..", "..", "..", "..");
const TEMPLATE_PATH = join(REPO_ROOT, "templates", "review.md");
const FIXTURE_PATH = join(moduleDir, "__fixtures__", "review-corpus-shapes.md");

const templateText = readFileSync(TEMPLATE_PATH, "utf-8");
const fixtureText = readFileSync(FIXTURE_PATH, "utf-8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split the fixture into its `=== SHAPE: <name> ===` blocks. */
function fixtureBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const parts = fixtureText.split(/^=== SHAPE: (.+) ===$/m);
  // parts[0] is the preamble; thereafter [name, body, name, body, ...].
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i]?.trim();
    const body = parts[i + 1];
    if (name && body !== undefined) blocks.set(name, body.trimStart());
  }
  return blocks;
}

/** The `#### Violations` table lines (header + separator) declared by the live template. */
function templateViolationsTable(): { header: string; separator: string; row: string } {
  const section = templateText.match(/####\s+Violations\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  const lines = (section?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  return { header: lines[0] ?? "", separator: lines[1] ?? "", row: lines[2] ?? "" };
}

/** The template's `#### Honored` bullet line. */
function templateHonoredLine(): string {
  const section = templateText.match(/####\s+Honored\s*\n([\s\S]*?)(?=\n####|\n###|\n##|$)/);
  const lines = (section?.[1] ?? "").split("\n").map((l) => l.trim());
  return lines.find((l) => l.startsWith("- ")) ?? "";
}

/**
 * Substitute realistic values for the template's `{placeholder}` cells.
 *
 * The template's literal cells carry `{id}` / `{principle-id}`, which the dec-02 charset
 * guard CORRECTLY rejects (braces are outside the closed domain). Substituting realistic
 * values is the fix; weakening the guard to make a placeholder parse would defeat ADR-0058
 * to satisfy a test. The `{HIGH\|MEDIUM\|LOW\|INSUFFICIENT\|—}` confidence cell is left
 * VERBATIM on purpose — it is not a machine-read column, and keeping it proves an escaped
 * pipe does not shift the columns that are.
 */
function substitutePlaceholders(line: string): string {
  return line
    .replace(/\{principle-id\}/g, "errors-are-values")
    .replace(/\{id\}/g, "errors-are-values")
    .replace(/\{rule\/strong-opinion\/convention\}/g, "rule")
    .replace(/\{what violates\}/g, "throws on an expected condition")
    .replace(/\{how to fix\}/g, "return a Result")
    .replace(/\{how honored\}/g, "gate returns a Result");
}

/** Build a parseable mini-review document around a violations table. */
function reviewWithTable(header: string, separator: string, row: string): string {
  return `---\nverdict: WARNING\nfiles-reviewed: 1\nprinciples-checked: 4\n---\n\n#### Violations\n${header}\n${separator}\n${row}\n`;
}

const RAW_BODY = "# Principle\n\nBody text.";
const BODY_HASH = hashContent(RAW_BODY);

/** Provenance carrying one artifact per expected id, so a parsed id joins and is observable. */
function provenanceFor(ids: string[]): ContextProvenanceSummary[] {
  return [
    {
      agent_id: "agent-1",
      agent_name: "canon:reviewer",
      artifact_count: ids.length,
      artifacts: ids.map((id) => ({
        char_span: [0, RAW_BODY.length] as [number, number],
        content_hash: BODY_HASH,
        id,
        kind: "rule" as const,
        path: `rules/${id}.md`,
        trust_tier: "trusted" as const,
      })),
      spawned_at: "2026-07-01T00:00:00.000Z",
      step_id: "review",
    },
  ];
}

/**
 * Resolve honored raw lines to parsed ids through the REAL attributeHonored.
 *
 * A line whose id parses AND matches an in-context artifact surfaces as an attribution
 * (proving both that it parsed and what it parsed to); a line that does not parse lands in
 * `unattributed` with reason "unparseable_honored". The honored-id parser is private by
 * design, so this drives it through its real public entry point rather than exporting it
 * for the test.
 */
function honoredIds(
  rawLines: string[],
  expectedIds: string[],
): {
  attributed: string[];
  unparseable: string[];
} {
  const honored: HonoredEntry[] = rawLines.map((raw) => ({ raw, step_id: "review" }));
  const result = attributeHonored({
    honored,
    provenance: provenanceFor(expectedIds),
    readCurrentBody: () => RAW_BODY,
  });
  return {
    attributed: result.attributions.map((a) => a.target_artifact.id).sort(),
    unparseable: result.unattributed
      .filter((u) => u.reason === "unparseable_honored")
      .map((u) => u.honored.raw),
  };
}

// ---------------------------------------------------------------------------
// Direction A — templates/review.md -> parser
// ---------------------------------------------------------------------------

describe("Direction A: the shipped parser can read what templates/review.md prescribes", () => {
  it("actually read a non-empty template (a missing file would make this direction vacuous)", () => {
    expect(templateText.length).toBeGreaterThan(0);
    expect(templateText).toContain("#### Violations");
  });

  it("parses a row in the template's declared violations shape", () => {
    const { header, separator, row } = templateViolationsTable();
    expect(header).toContain("Principle");

    const substituted = substitutePlaceholders(row);
    // Any placeholder left over means the template grew a cell this test does not model —
    // fail loudly rather than silently asserting against `{something}`.
    expect(substituted.replace(/\{HIGH[^}]*\}/, "")).not.toMatch(/\{[^}]+\}/);

    const parsed = parseReviewFile(reviewWithTable(header, separator, substituted));

    expect(parsed?.violations).toHaveLength(1);
    expect(parsed?.violations[0].principle_id).toBe("errors-are-values");
    expect(parsed?.violations[0].severity).toBe("rule");
  });

  it("parses the honored line shape the template prescribes", () => {
    const line = templateHonoredLine();
    expect(line).toContain("**");

    const raw = substitutePlaceholders(line).replace(/^-\s*/, "");
    const { attributed } = honoredIds([raw], ["errors-are-values"]);

    expect(attributed).toEqual(["errors-are-values"]);
  });
});

// ---------------------------------------------------------------------------
// Direction B — checked-in corpus fixture -> parser
// ---------------------------------------------------------------------------

/** Every measured violation shape and the id the shipped parser must recover from it. */
const EXPECTED_VIOLATION_IDS: Record<string, string> = {
  "canonical-4col": "errors-are-values",
  "file-column-5col": "tests-are-deterministic",
  "full-6col-escaped-pipe": "fail-closed-by-default",
  "minimal-3col": "single-source-of-truth",
  "ordinal-file-6col": "observable-best-effort",
  "ordinal-location-5col": "validate-at-trust-boundaries",
};

describe("Direction B: every shape measured in the real corpus still parses", () => {
  const blocks = fixtureBlocks();

  it("every fixture block has an expectation (a block nobody asserts is dead weight)", () => {
    const asserted = new Set([
      ...Object.keys(EXPECTED_VIOLATION_IDS),
      "prose-row-rejected",
      "honored-shapes",
    ]);
    expect([...blocks.keys()].sort()).toEqual([...asserted].sort());
  });

  for (const [shape, expectedId] of Object.entries(EXPECTED_VIOLATION_IDS)) {
    it(`extracts ${expectedId} from the ${shape} shape`, () => {
      const block = blocks.get(shape);
      expect(block).toBeDefined();

      const parsed = parseReviewFile(block as string);

      expect(parsed?.violations).toHaveLength(1);
      expect(parsed?.violations[0].principle_id).toBe(expectedId);
    });
  }

  it("an escaped pipe inside a cell does not shift the parsed columns", () => {
    const parsed = parseReviewFile(blocks.get("full-6col-escaped-pipe") as string);

    // Location is read from a column AFTER the escaped-pipe cell: a naive split("|") would
    // shift it (and silently drop the row) rather than land it here.
    expect(parsed?.violations[0].file_path).toBe("hooks/gate.sh:4");
    expect(parsed?.violations[0].message).toBe("gate fails open");
  });

  it("rejects prose rows rather than recording them as principle ids", () => {
    const parsed = parseReviewFile(blocks.get("prose-row-rejected") as string);
    expect(parsed?.violations).toEqual([]);
  });

  it("parses all measured honored shapes and rejects the prose entry", () => {
    const block = blocks.get("honored-shapes") as string;
    const rawLines = (parseReviewFile(block)?.honored ?? []) as string[];
    expect(rawLines).toHaveLength(5);

    const { attributed, unparseable } = honoredIds(rawLines, [
      "errors-are-values",
      "fail-closed-by-default",
      "single-source-of-truth",
    ]);

    // Bare `**id**`, `**id**: desc`, and `**id** — desc` all yield their id.
    expect(attributed).toEqual([
      "errors-are-values",
      "fail-closed-by-default",
      "single-source-of-truth",
    ]);

    // The unbolded residual shape and the prose entry are both dropped, never coerced.
    expect(unparseable).toContain("tests-are-deterministic (rule)");
    expect(unparseable).toContain("**DOCUMENTED FAIL-OPEN on the new git-log call**");
  });
});

// ---------------------------------------------------------------------------
// Teeth — the gate must be able to fail, and must not weaken the guard
// ---------------------------------------------------------------------------

describe("the gate has teeth", () => {
  it("a violations table whose header the parser cannot read yields no violations", () => {
    // The exact failure Direction A catches: if templates/review.md's header were edited to
    // an unreadable shape, rows would silently vanish instead of parsing.
    const broken = reviewWithTable(
      "| Foo | Bar |",
      "|-----|-----|",
      "| errors-are-values | rule |",
    );
    expect(parseReviewFile(broken)?.violations).toEqual([]);
  });

  it("does not weaken the charset guard to accommodate the template's placeholder", () => {
    expect(isPrincipleIdShaped("{id}")).toBe(false);
    expect(isPrincipleIdShaped("{principle-id}")).toBe(false);
    expect(isPrincipleIdShaped("errors-are-values")).toBe(true);
  });

  it("is anchored to a checked-in fixture, never the gitignored runtime corpus", () => {
    // A gate reading the gitignored history corpus passes locally and no-ops in CI,
    // asserting nothing. Scan CODE lines only — the prose above deliberately names that
    // path to explain the hazard, and the needle is assembled rather than written as a
    // literal so this assertion cannot match itself.
    const needle = [".canon", "history"].join("/");
    const codeLines = readFileSync(fileURLToPath(import.meta.url), "utf-8")
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      });

    expect(codeLines.some((line) => line.includes(needle))).toBe(false);
    expect(fixtureText.length).toBeGreaterThan(0);
  });
});
