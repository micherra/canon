export const CRAFT_DIMENSIONS = [
  "simplicity",
  "cohesion",
  "interface-depth",
  "naming",
  "locality",
  "predictability",
] as const;
export type CraftDimension = (typeof CRAFT_DIMENSIONS)[number];

export const CRAFT_BANDS = ["strong", "adequate", "weak", "n-a"] as const;
export type CraftBand = (typeof CRAFT_BANDS)[number];

/** Dimension -> backing Canon principle IDs (from craft-definition.md). */
export const CRAFT_DIMENSION_PRINCIPLES: Record<CraftDimension, string[]> = {
  cohesion: ["functions-do-one-thing", "command-query-separation", "consistent-abstraction-levels"],
  "interface-depth": ["deep-modules", "information-hiding", "law-of-demeter"],
  locality: ["leave-touched-files-better", "refactoring-integrity"],
  naming: ["ubiquitous-language-in-code", "compute-effect-naming-convention"],
  predictability: ["no-hidden-side-effects", "prefer-immutable-data"],
  simplicity: ["simplicity-first", "patterns-need-justification"],
};

/** Band -> ordinal for trend math only. n-a excluded (returns null). */
export function craftBandOrdinal(band: CraftBand): number | null {
  switch (band) {
    case "strong":
      return 3;
    case "adequate":
      return 2;
    case "weak":
      return 1;
    case "n-a":
      return null;
  }
}
