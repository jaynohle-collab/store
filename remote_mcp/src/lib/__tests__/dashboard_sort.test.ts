import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_JOB_ORDER_BY_SQL,
  paginateSortedJobs,
  type SortableJob,
} from "@/lib/dashboard/sort";
import { formatMatch } from "@/lib/dashboard/display";

const dashboardSqlPath = path.resolve(__dirname, "../db/dashboard.ts");
const dashboardSqlSource = readFileSync(dashboardSqlPath, "utf8");

function makeJobs(count: number): SortableJob[] {
  const jobs: SortableJob[] = [];
  for (let i = 0; i < count; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    jobs.push({
      id,
      // Newest first_seen is high i — deliberately inverse of match score.
      first_seen_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      posted_date: new Date(Date.UTC(2025, 11, 31, 0, 0, count - i)).toISOString(),
      company: `Company ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`,
      match_score: i, // highest scores are the highest indexes
    });
  }
  return jobs;
}

describe("listDashboardJobs SQL sort-before-pagination", () => {
  it("uses fixed ORDER BY branches before LIMIT/OFFSET (no JS post-sort)", () => {
    for (const clause of Object.values(DASHBOARD_JOB_ORDER_BY_SQL)) {
      expect(dashboardSqlSource).toContain(clause);
    }
    // Ensure ORDER BY appears before LIMIT in each sort branch for match.
    const matchIdx = dashboardSqlSource.indexOf(DASHBOARD_JOB_ORDER_BY_SQL.match);
    const limitAfterMatch = dashboardSqlSource.indexOf("LIMIT ${fetchLimit}", matchIdx);
    expect(matchIdx).toBeGreaterThan(-1);
    expect(limitAfterMatch).toBeGreaterThan(matchIdx);

    // No page-level Array.sort after the query result mapping.
    expect(dashboardSqlSource).not.toMatch(/jobs\.sort\(/);
    expect(dashboardSqlSource).not.toMatch(/page\.sort\(/);
  });

  it("sort=match page 1 contains globally highest scores across 100+ rows", () => {
    const jobs = makeJobs(120);
    const page = paginateSortedJobs(jobs, "match", 10, 0);
    expect(page).toHaveLength(10);
    expect(page.map((j) => j.match_score)).toEqual([119, 118, 117, 116, 115, 114, 113, 112, 111, 110]);
    // Not the newest-first page (those would be ids with highest first_seen = high i still,
    // but prove we didn't take an arbitrary newest slice then sort):
    const newestPageThenSort = [...jobs]
      .sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at))
      .slice(0, 10)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0));
    // Newest 10 are scores 119..110 coincidentally same set here — rotate so newest ≠ top match
    const rotated = makeJobs(120).map((j, idx) => ({
      ...j,
      match_score: (idx * 7) % 120,
    }));
    const matchPage = paginateSortedJobs(rotated, "match", 10, 0);
    const wrong = [...rotated]
      .sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at))
      .slice(0, 10)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0));
    expect(matchPage.map((j) => j.match_score)).not.toEqual(wrong.map((j) => j.match_score));
    const globalTop = [...rotated]
      .sort((a, b) => (b.match_score ?? -Infinity) - (a.match_score ?? -Infinity))
      .slice(0, 10)
      .map((j) => j.match_score);
    expect(matchPage.map((j) => j.match_score)).toEqual(globalTop);
  });

  it("sort=posted page 1 contains globally latest posted dates across 100+ rows", () => {
    const jobs = makeJobs(120);
    const page = paginateSortedJobs(jobs, "posted", 10, 0);
    const globalTop = [...jobs]
      .sort(
        (a, b) =>
          Date.parse(b.posted_date ?? b.first_seen_at) -
          Date.parse(a.posted_date ?? a.first_seen_at),
      )
      .slice(0, 10)
      .map((j) => j.id);
    expect(page.map((j) => j.id)).toEqual(globalTop);
  });

  it("sort=company page 1 is globally alphabetical across 100+ rows", () => {
    const jobs = makeJobs(120);
    const page = paginateSortedJobs(jobs, "company", 10, 0);
    const globalTop = [...jobs]
      .sort((a, b) => {
        const ac = (a.company ?? "").toLowerCase();
        const bc = (b.company ?? "").toLowerCase();
        if (ac !== bc) return ac < bc ? -1 : 1;
        return Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at);
      })
      .slice(0, 10)
      .map((j) => j.company);
    expect(page.map((j) => j.company)).toEqual(globalTop);
  });
});

describe("simple-v1 match display", () => {
  it("does not render a percent sign for point scores", () => {
    expect(formatMatch(22)).toBe("22");
    expect(formatMatch(15.6)).toBe("16");
    expect(formatMatch(null)).toBe("—");
    expect(formatMatch(22)).not.toContain("%");
  });
});
