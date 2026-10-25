import { describe, expect, it } from "vitest";

import { sortJobs } from "@/lib/dashboard/job_sort";

const jobs = [
  { posting_id: "a", title: "Staff Engineer", company: "Beta", gpt_relevance_score: 72, posted_date: "2026-10-20" },
  { posting_id: "b", title: "backend engineer", company: "alpha", gpt_relevance_score: null, posted_date: "2026-10-24" },
  { posting_id: "c", title: "AI Engineer", company: "Gamma", gpt_relevance_score: 88, posted_date: null },
];
const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.posting_id);

describe("sortJobs", () => {
  it("sorts titles case-insensitively both ways", () => {
    expect(ids(sortJobs(jobs, "title", "asc"))).toEqual(["c", "b", "a"]);
    expect(ids(sortJobs(jobs, "title", "desc"))).toEqual(["a", "b", "c"]);
  });
  it("sorts numbers numerically with empties last", () => {
    expect(ids(sortJobs(jobs, "fit", "desc"))).toEqual(["c", "a", "b"]);
    expect(ids(sortJobs(jobs, "fit", "asc"))).toEqual(["a", "c", "b"]);
  });
  it("keeps empty dates last", () => {
    expect(ids(sortJobs(jobs, "posted", "desc"))).toEqual(["b", "a", "c"]);
  });
  it("leaves order unchanged without a key", () => {
    expect(ids(sortJobs(jobs, null, "asc"))).toEqual(["a", "b", "c"]);
  });
});
