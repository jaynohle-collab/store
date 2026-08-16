import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(
  path.resolve(__dirname, "../db/dashboard.ts"),
  "utf8",
);

describe("active scoring_version / profile_version selection", () => {
  it("filters latest_eval to configured scoring and profile versions", () => {
    expect(dashboardSource).toContain("scoring_version = ${p.scoringVersion}");
    expect(dashboardSource).toContain("profile_version = ${p.profileVersion}");
    expect(dashboardSource).toContain("getActiveScoringVersion");
    expect(dashboardSource).toContain("getActiveProfileVersion");
  });

  it("does not mix canonical_similarity_score into match_score columns", () => {
    expect(dashboardSource).not.toMatch(/canonical_similarity_score/);
  });

  it("getDashboardJob looks up directly without calling listDashboardJobs", () => {
    const fnStart = dashboardSource.indexOf("export async function getDashboardJob");
    const fnEnd = dashboardSource.indexOf("export async function getDashboardSummary");
    const body = dashboardSource.slice(fnStart, fnEnd);
    expect(body).not.toContain("listDashboardJobs");
  });
});
