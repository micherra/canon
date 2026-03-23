import { DriftStore } from "../drift/store.js";

export interface GetPatternsInput {
  limit?: number;
}

export interface PatternGroup {
  pattern: string;
  count: number;
  file_paths: string[];
  first_seen: string;
  last_seen: string;
}

export interface GetPatternsOutput {
  patterns: PatternGroup[];
  total_entries: number;
}

export async function getPatterns(
  input: GetPatternsInput,
  projectDir: string
): Promise<GetPatternsOutput> {
  const store = new DriftStore(projectDir);
  const raw = await store.getPatterns();

  // Group by exact pattern text
  const groupMap = new Map<string, { file_paths: Set<string>; timestamps: string[] }>();
  for (const p of raw) {
    const existing = groupMap.get(p.pattern) || { file_paths: new Set(), timestamps: [] };
    for (const fp of p.file_paths) {
      existing.file_paths.add(fp);
    }
    existing.timestamps.push(p.timestamp);
    groupMap.set(p.pattern, existing);
  }

  let patterns: PatternGroup[] = [...groupMap.entries()]
    .map(([pattern, data]) => {
      const ts = data.timestamps;
      return {
        pattern,
        count: ts.length,
        file_paths: [...data.file_paths],
        first_seen: ts.reduce((a, b) => (a < b ? a : b)),
        last_seen: ts.reduce((a, b) => (a > b ? a : b)),
      };
    })
    .sort((a, b) => b.count - a.count);

  if (input.limit && input.limit > 0) {
    patterns = patterns.slice(0, input.limit);
  }

  return { patterns, total_entries: raw.length };
}
