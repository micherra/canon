/** Compute weekly compliance pass rates for a principle from reviews.jsonl. */

import { join } from "path";
import { z } from "zod";
import { readJsonl } from "../drift/jsonl-store.js";
import { CANON_DIR } from "../constants.js";
import type { ReviewEntry } from "../schema.js";

export const GetComplianceTrendInputSchema = z.object({
  principle_id: z.string().min(1).describe("ID of the principle to compute trend for"),
});

export type GetComplianceTrendInput = z.infer<typeof GetComplianceTrendInputSchema>;

export interface TrendPoint {
  week: string;       // ISO week: "2026-W12"
  pass_rate: number;  // 0–1
}

export interface GetComplianceTrendOutput {
  trend: TrendPoint[];
}

/** Convert an ISO timestamp to ISO week string (e.g. "2026-W12"). */
function toISOWeek(timestamp: string): string {
  const date = new Date(timestamp);
  const jan4 = new Date(date.getFullYear(), 0, 4);
  const dayOfYear =
    Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86400000
    ) + 1;
  const weekNum = Math.ceil((dayOfYear + jan4.getDay() - 1) / 7);
  return `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export async function getComplianceTrend(
  input: GetComplianceTrendInput,
  projectDir: string,
): Promise<GetComplianceTrendOutput> {
  const parsed = GetComplianceTrendInputSchema.safeParse(input);
  if (!parsed.success) return { trend: [] };

  const { principle_id } = parsed.data;

  const reviewsPath = join(projectDir, CANON_DIR, "reviews.jsonl");

  let reviews: ReviewEntry[];
  try {
    reviews = await readJsonl<ReviewEntry>(reviewsPath, (r) =>
      r.violations?.some((v) => v.principle_id === principle_id) ||
      r.honored?.includes(principle_id)
    );
  } catch {
    return { trend: [] };
  }

  if (reviews.length === 0) return { trend: [] };

  const buckets = new Map<string, { violations: number; passes: number }>();

  for (const review of reviews) {
    if (!review.timestamp) continue;
    const week = toISOWeek(review.timestamp);
    const bucket = buckets.get(week) ?? { violations: 0, passes: 0 };

    if (review.violations?.some((v) => v.principle_id === principle_id)) {
      bucket.violations++;
    }
    if (review.honored?.includes(principle_id)) {
      bucket.passes++;
    }

    buckets.set(week, bucket);
  }

  const trend: TrendPoint[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { violations, passes }]) => {
      const total = violations + passes;
      return {
        week,
        pass_rate: total > 0 ? Math.round((passes / total) * 100) / 100 : 0,
      };
    });

  return { trend };
}
