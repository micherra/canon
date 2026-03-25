import { type DriftReport } from "./analyzer.ts";

export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];

  lines.push("## Canon Drift Report");
  lines.push("");

  // Overview
  lines.push(`### Overview (${report.total_reviews} reviews, ${report.total_decisions} decisions)`);
  lines.push(`Avg score: Rules ${report.avg_score.rules}% | Opinions ${report.avg_score.opinions}% | Conventions ${report.avg_score.conventions}%`);
  lines.push(`Trend: ${formatTrend(report.trend)}`);
  lines.push(`Intentional deviation ratio: ${report.intentional_ratio}%`);
  lines.push("");

  // Most violated
  if (report.most_violated.length > 0) {
    lines.push("### Most violated principles");
    for (const stat of report.most_violated) {
      lines.push(
        `${stat.principle_id} — ${stat.total_violations} violations (${stat.unintentional_violations} unintentional), ${stat.compliance_rate}% compliance`
      );
    }
    lines.push("");
  }

  // Hotspots
  if (report.violation_directories.length > 0) {
    lines.push("### Hotspot directories");
    for (const dir of report.violation_directories) {
      lines.push(`${dir.directory} — ${dir.total_violations} violations across ${dir.review_count} reviews`);
    }
    lines.push("");
  }

  // Recent decisions
  if (report.recent_decisions.length > 0) {
    lines.push("### Intentional deviation log (last 5)");
    for (const d of report.recent_decisions) {
      const date = d.timestamp.split("T")[0];
      lines.push(`- [${date}] ${d.principle_id} in ${d.file_path}`);
      lines.push(`  "${d.justification}"`);
    }
    lines.push("");
  }

  // Never triggered
  if (report.never_triggered.length > 0) {
    lines.push("### Never-triggered principles");
    lines.push("These principles have never appeared in any review:");
    for (const id of report.never_triggered) {
      lines.push(`- ${id}`);
    }
    lines.push("");
  }

  // Recommendations
  lines.push("### Recommendations");
  const recommendations = generateRecommendations(report);
  if (recommendations.length === 0) {
    lines.push("No recommendations at this time.");
  } else {
    for (const rec of recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  return lines.join("\n");
}

function formatTrend(trend: DriftReport["trend"]): string {
  switch (trend) {
    case "improving":
      return "Improving (fewer violations in recent reviews)";
    case "stable":
      return "Stable";
    case "declining":
      return "Declining (more violations in recent reviews)";
    case "insufficient_data":
      return "Insufficient data (need 6+ reviews for trend analysis)";
  }
}

function generateRecommendations(report: DriftReport): string[] {
  const recs: string[] = [];

  // High-violation principles
  for (const stat of report.most_violated.slice(0, 3)) {
    if (stat.compliance_rate < 50) {
      recs.push(
        `Consider revising **${stat.principle_id}** — ${stat.compliance_rate}% compliance suggests the principle may be too strict or unclear.`
      );
    } else if (stat.unintentional_violations > 5) {
      recs.push(
        `**${stat.principle_id}** has ${stat.unintentional_violations} unintentional violations. Consider adding more examples to the principle or running a focused review.`
      );
    }
  }

  // Hotspot directories
  for (const dir of report.violation_directories.slice(0, 2)) {
    if (dir.total_violations > 5) {
      recs.push(
        `**${dir.directory}** is a hotspot with ${dir.total_violations} violations. Consider a dedicated code review pass.`
      );
    }
  }

  // Never-triggered principles
  if (report.never_triggered.length > 3) {
    recs.push(
      `${report.never_triggered.length} principles have never been triggered. Review them for relevance — they may be too narrowly scoped.`
    );
  }

  // Low intentional ratio
  if (report.intentional_ratio < 30 && report.most_violated.length > 0) {
    recs.push(
      `Only ${report.intentional_ratio}% of deviations are intentional. Encourage using the \`report\` tool (type=decision) to log justified deviations.`
    );
  }

  return recs;
}
