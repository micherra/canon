import { DriftStore } from "../drift/store.js";
import type { DecisionEntry } from "../schema.js";

export interface GetDecisionsInput {
  principle_id?: string;
  limit?: number;
}

export interface DecisionGroup {
  principle_id: string;
  count: number;
  categories: Record<string, number>;
  decisions: DecisionEntry[];
}

export interface GetDecisionsOutput {
  groups: DecisionGroup[];
  total_entries: number;
}

export async function getDecisions(
  input: GetDecisionsInput,
  projectDir: string
): Promise<GetDecisionsOutput> {
  const store = new DriftStore(projectDir);
  const decisions = await store.getDecisions(input.principle_id);

  function buildGroup(principle_id: string, entries: DecisionEntry[]): DecisionGroup {
    const categories: Record<string, number> = {};
    for (const e of entries) {
      const cat = e.category || "uncategorized";
      categories[cat] = (categories[cat] || 0) + 1;
    }
    return { principle_id, count: entries.length, categories, decisions: entries };
  }

  let groups: DecisionGroup[];

  if (input.principle_id) {
    // Already filtered to one principle — skip grouping
    groups = decisions.length > 0
      ? [buildGroup(input.principle_id, decisions)]
      : [];
  } else {
    const groupMap = new Map<string, DecisionEntry[]>();
    for (const d of decisions) {
      let existing = groupMap.get(d.principle_id);
      if (!existing) {
        existing = [];
        groupMap.set(d.principle_id, existing);
      }
      existing.push(d);
    }

    groups = [...groupMap.entries()]
      .map(([pid, entries]) => buildGroup(pid, entries))
      .sort((a, b) => b.count - a.count);
  }

  if (input.limit && input.limit > 0) {
    groups = groups.slice(0, input.limit);
  }

  return { groups, total_entries: decisions.length };
}
