import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/dashboard/auth", () => ({ requireDashboardApiUser: vi.fn(), dashboardAuthErrorResponse: vi.fn() }));
vi.mock("@/lib/db/keyword_review", () => ({ listKeywordReviewLinks: vi.fn() }));
import { requireDashboardApiUser, dashboardAuthErrorResponse } from "@/lib/dashboard/auth";
import { listKeywordReviewLinks } from "@/lib/db/keyword_review";
import { GET } from "./route";
const auth = vi.mocked(requireDashboardApiUser), list = vi.mocked(listKeywordReviewLinks);
beforeEach(() => { vi.resetAllMocks(); auth.mockResolvedValue({ email: "test@example.com", emailVerified: true }); });
describe("all matching link export", () => {
  it("exports beyond a page, dedupes and ignores profile injection", async () => {
    const links = Array.from({length: 123}, (_, i) => `https://jobs.greenhouse.io/example/${i}`);
    list.mockResolvedValue([...links, links[0], "javascript:alert(1)"]);
    const response = await GET(new Request("https://example.com/api/keyword-review/links?offset=50&profileId=other&from=2026-11-13&to=2026-11-13"));
    expect(response.status).toBe(200); expect((await response.json()).links).toEqual(links);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(list).toHaveBeenCalledWith({ q: "", bucket: undefined, newOnly: false, offset: 0, freshSince: "2026-11-13T00:00:00.000Z", freshBefore: "2026-11-14T00:00:00.000Z" });
  });
  it("requires auth before touching data", async () => {
    auth.mockRejectedValue(new Error("denied")); vi.mocked(dashboardAuthErrorResponse).mockReturnValue(new Response("denied", {status: 401}) as never);
    expect((await GET(new Request("https://example.com/api/keyword-review/links"))).status).toBe(401); expect(list).not.toHaveBeenCalled();
  });
  it("rejects invalid date ranges", async () => { expect((await GET(new Request("https://example.com/api/keyword-review/links?from=2026-99-01"))).status).toBe(400); expect(list).not.toHaveBeenCalled(); });
  it("does not return partial results or private errors", async () => {
    list.mockRejectedValue(new Error("EXPORT_TOO_LARGE")); expect((await GET(new Request("https://example.com/api/keyword-review/links"))).status).toBe(413);
    list.mockRejectedValue(new Error("private db credentials")); const res = await GET(new Request("https://example.com/api/keyword-review/links")); expect(res.status).toBe(503); expect(await res.text()).not.toContain("credentials");
  });
});
