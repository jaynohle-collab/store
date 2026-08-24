import { describe, expect, it } from "vitest";

import {
  buildDashboardQueryString,
  buildPaginationMeta,
  clampPage,
  normalizeDashboardSearch,
  parseAppliedSort,
  parsePage,
  parsePageSize,
  parseRemoteFilter,
  parseToApplySort,
  searchPattern,
  totalPages,
} from "@/lib/dashboard/query_params";

describe("dashboard query params", () => {
  it("normalizes search and treats empty as show-all", () => {
    expect(normalizeDashboardSearch("  acme  corp  ")).toBe("acme corp");
    expect(normalizeDashboardSearch("")).toBeNull();
    expect(normalizeDashboardSearch(undefined)).toBeNull();
    expect(searchPattern(normalizeDashboardSearch("python"))).toBe("%python%");
    expect(searchPattern(null)).toBeNull();
  });

  it("parses page size allowlist", () => {
    expect(parsePageSize("25")).toBe(25);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("100")).toBe(100);
    expect(parsePageSize("99")).toBe(25);
    expect(parsePageSize(undefined)).toBe(25);
  });

  it("escapes ILIKE metacharacters in search patterns", () => {
    expect(searchPattern(normalizeDashboardSearch("50%_off"))).toBe("%50\\%\\_off%");
  });

  it("clamps invalid page numbers including decimals", () => {
    expect(parsePage(0)).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("2")).toBe(2);
    expect(clampPage(99, 3)).toBe(3);
    expect(totalPages(143, 25)).toBe(6);
  });

  it("builds pagination metadata ranges", () => {
    const meta = buildPaginationMeta(143, 2, 25);
    expect(meta.rangeStart).toBe(26);
    expect(meta.rangeEnd).toBe(50);
    expect(meta.hasPrevious).toBe(true);
    expect(meta.hasNext).toBe(true);
  });

  it.each([
    ["match", "match"],
    ["gpt", "gpt"],
    ["bogus", "match"],
  ])("falls back invalid To Apply sort %s → %s", (input, expected) => {
    expect(parseToApplySort(input)).toBe(expected);
  });

  it.each([
    ["applied", "applied"],
    ["company", "company"],
    ["bad", "applied"],
  ])("falls back invalid Applied sort %s → %s", (input, expected) => {
    expect(parseAppliedSort(input)).toBe(expected);
  });

  it("defaults remote filter to remote_us", () => {
    expect(parseRemoteFilter(undefined)).toBe("remote_us");
    expect(parseRemoteFilter("all")).toBe("all");
  });

  it("preserves search sort and filter in query strings", () => {
    const qs = buildDashboardQueryString({
      q: "python",
      sort: "gpt",
      remote: "remote_us",
      page: 2,
      pageSize: 50,
    });
    expect(qs).toContain("q=python");
    expect(qs).toContain("sort=gpt");
    expect(qs).toContain("remote=remote_us");
    expect(qs).toContain("page=2");
    expect(qs).toContain("pageSize=50");
  });
});
