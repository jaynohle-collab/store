import { describe, expect, it } from "vitest";

import {
  MAX_DASHBOARD_SEARCH_LENGTH,
  buildPaginationMeta,
  clampPage,
  escapeIlikeLiteral,
  normalizeDashboardSearch,
  parsePage,
  searchPattern,
  totalPages,
} from "@/lib/dashboard/query_params";

describe("pagination hardening", () => {
  it("returns total count and clamps out-of-range pages", () => {
    const total = 47;
    const pageSize = 25;
    const pages = totalPages(total, pageSize);
    expect(pages).toBe(2);
    expect(clampPage(999, pages)).toBe(2);
    const meta = buildPaginationMeta(total, clampPage(999, pages), 25);
    expect(meta.page).toBe(2);
    expect(meta.total).toBe(47);
    expect(meta.rangeStart).toBe(26);
    expect(meta.rangeEnd).toBe(47);
    expect(meta.hasNext).toBe(false);
  });

  it("handles empty result sets on any requested page", () => {
    const meta = buildPaginationMeta(0, parsePage(999), 25);
    expect(meta.total).toBe(0);
    expect(meta.totalPages).toBe(0);
    expect(meta.page).toBe(1);
    expect(meta.rangeStart).toBe(0);
    expect(meta.rangeEnd).toBe(0);
    expect(meta.hasNext).toBe(false);
  });

  it.each([
    ["0", 1],
    ["-3", 1],
    ["NaN", 1],
    ["1.9", 1],
    ["abc", 1],
    ["", 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])("parsePage(%s) falls back safely", (input, expected) => {
    expect(parsePage(input as string | number)).toBe(expected);
  });

  it("accepts large but finite integer page strings", () => {
    const huge = String(Number.MAX_SAFE_INTEGER);
    expect(parsePage(huge)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("search escaping and limits", () => {
  it("escapes ILIKE metacharacters", () => {
    expect(escapeIlikeLiteral("100%")).toBe("100\\%");
    expect(escapeIlikeLiteral("a_b")).toBe("a\\_b");
    expect(escapeIlikeLiteral("path\\dir")).toBe("path\\\\dir");
    expect(searchPattern("100% done")).toBe("%100\\% done%");
  });

  it("treats whitespace-only input as empty search", () => {
    expect(normalizeDashboardSearch("   \t  ")).toBeNull();
    expect(searchPattern(normalizeDashboardSearch("   "))).toBeNull();
  });

  it("caps search length", () => {
    const long = "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH + 50);
    expect(normalizeDashboardSearch(long)?.length).toBe(MAX_DASHBOARD_SEARCH_LENGTH);
  });

  it("preserves Unicode without stripping", () => {
    const q = normalizeDashboardSearch("résumé 日本語");
    expect(q).toBe("résumé 日本語");
    expect(searchPattern(q)).toBe("%résumé 日本語%");
  });

  it("does not treat SQL fragments as syntax when escaped", () => {
    const injection = "'; DROP TABLE applications; --";
    const pattern = searchPattern(normalizeDashboardSearch(injection));
    expect(pattern).toBe("%'; DROP TABLE applications; --%");
    expect(pattern).not.toContain("%_%");
  });
});
