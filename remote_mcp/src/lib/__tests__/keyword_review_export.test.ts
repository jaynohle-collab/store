import { describe, expect, it, vi } from "vitest";
vi.mock("../db/client", () => ({ getSql: vi.fn() }));
vi.mock("../dashboard/time", () => ({ getActiveProfileId: () => "fixture" }));
import { listKeywordReviewLinks } from "../db/keyword_review";
describe("single snapshot full link query", () => {
  it("queries all pages with profile and date bounds", async () => {
    let query = ""; let values: unknown[] = [];
    const sql = async (strings: TemplateStringsArray, ...params: unknown[]) => { query = strings.join("?"); values = params; return [{url: "https://jobs.example.com/a"}]; };
    expect(await listKeywordReviewLinks({ offset: 100, freshSince: "2026-01-01T00:00:00Z", freshBefore: "2026-01-02T00:00:00Z" }, sql as never)).toHaveLength(1);
    expect(query).toContain("LIMIT 20001"); expect(query).not.toContain("OFFSET"); expect(query).toContain("first_seen_at<"); expect(values).toContain("fixture");
  });
  it("fails explicitly at the export safety ceiling", async () => { const sql = async () => Array.from({length:20001}, () => ({url:"x"})); await expect(listKeywordReviewLinks({}, sql as never)).rejects.toThrow("EXPORT_TOO_LARGE"); });
});
