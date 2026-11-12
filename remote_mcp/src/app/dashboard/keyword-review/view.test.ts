import { describe, expect, it } from "vitest";
import { parseReviewFilters, reviewPageHref, safeListingHref, reviewDate } from "./view";
describe("keyword review view helpers", () => {
  it("validates filters", () => {
    expect(parseReviewFilters({ q: "  engineer  ", bucket: "stronger", new: "1", offset: "50" })).toEqual({ q: "engineer", bucket: "stronger", newOnly: true, offset: 50 });
    for (const offset of ["-1", "NaN", "1e3", "1.2", "9007199254740992"]) expect(parseReviewFilters({ offset }).offset).toBe(0);
    expect(parseReviewFilters({ bucket: "__proto__", new: "true", q: ["a", "b"] })).toEqual({ q: "", bucket: undefined, newOnly: false, offset: 0 });
  });
  it("preserves filters forward and backward", () => {
    const filters = parseReviewFilters({ q: "C++ & API", bucket: "broader", new: "1", offset: "50" });
    for (const offset of [0, 100]) {
      const url = new URL(reviewPageHref(filters, offset), "https://dashboard.invalid");
      expect(parseReviewFilters(Object.fromEntries(url.searchParams))).toEqual({ ...filters, offset });
    }
  });
  it("keeps exact supplied public URLs", () => {
    const url = "https://boards.greenhouse.io/acme/jobs/123?source=x%20y#details";
    expect(safeListingHref(url)).toBe(url);
  });
  it("rejects unsafe and local destinations", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/jobs", "/dashboard/jobs", "https://user:pass@example.com", "http://localhost/a", "https://a.local", "http://127.0.0.1", "http://2130706433", "http://0x7f000001", "http://[::1]", "http://192.168.0.1", "http://machine", "http://host.home.arpa", "https://localhost./x", "https://foo.internal", "https://good.com\\@localhost", "https://good.com\n"]) expect(safeListingHref(url), url).toBeNull();
  });
  it("handles unknown dates", () => {
    expect(reviewDate(null)).toBe("Unknown");
    expect(reviewDate("not a date")).toBe("Unknown");
    expect(reviewDate("2026-11-12T10:00:00Z")).toBe("2026-11-12 10:00 UTC");
  });
});
