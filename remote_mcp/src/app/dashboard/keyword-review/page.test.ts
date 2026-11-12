import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/db/keyword_review", () => ({ listKeywordReviewCandidates: vi.fn() }));
import { type KeywordReviewRow, listKeywordReviewCandidates } from "@/lib/db/keyword_review";
import KeywordReviewPage from "./page";
const list = vi.mocked(listKeywordReviewCandidates);
const render = async (params: Record<string, string> = {}) => renderToStaticMarkup(await KeywordReviewPage({ searchParams: Promise.resolve(params) }));
describe("read-only keyword review page", () => {
  beforeEach(() => list.mockReset());
  it("renders a safe empty state without mutation forms", async () => {
    list.mockResolvedValue({ candidates: [], nextOffset: null, available: true });
    const html = await render();
    expect(html).toContain("No matching jobs collected on this page");
    expect(html).toContain('method="get"');
    expect(html).not.toContain('method="post"');
    expect(html).toContain("This read-only page does not submit applications or change application status");
    expect(html).not.toContain("Applications remain paused");
  });
  it("hides internal errors and handles missing migrations", async () => {
    list.mockRejectedValueOnce(new Error("secret database internals"));
    const html = await render();
    expect(html).toContain("Keyword review is not available yet");
    expect(html).not.toContain("secret database internals");
    list.mockResolvedValue({ candidates: [], nextOffset: null, available: false });
    expect(await render()).toContain("Keyword review is not available yet");
  });
  it("preserves next and previous filter state", async () => {
    list.mockResolvedValue({ candidates: [], nextOffset: 100, available: true });
    const html = await render({ q: "C++", bucket: "broader", new: "1", offset: "50" });
    expect(html).toContain("q=C%2B%2B&amp;bucket=broader&amp;new=1&amp;offset=0");
    expect(html).toContain("q=C%2B%2B&amp;bucket=broader&amp;new=1&amp;offset=100");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "C++", bucket: "broader", newOnly: true, limit: 50, offset: 50 }));
  });
  it("escapes listing text, labels unknown dates, and uses safe external links", async () => {
    const candidate: KeywordReviewRow = {
      id: "one", title: "<script>alert(1)</script>", company: "Company", source: "ATS",
      url: "https://jobs.greenhouse.io/acme/123", bucket: "stronger", keyword_score: 12,
      newness: "new_to_review", first_seen_at: "2026-11-12T00:00:00Z", last_seen_at: "2026-11-12T00:00:00Z", seen_count: 1,
      matched_role_terms: ["SQL"], matched_keyword_groups: [{ group: "data", aliases: ["SQL"] }],
      warnings: ["eligibility_not_verified"], filter_reasons: ["excluded_role_term"], application_history: "not_checked", policy_version: "v1",
      normalized_url: "https://jobs.greenhouse.io/acme/123", candidate_key: "a".repeat(64),
      location_text: "", posted_date_text: "", label: "Keyword match, unverified",
      score_components: {}, matched_seniority_terms: [], listing_country_signal: "Unknown", listing_work_mode_signal: "Unknown",
      eligibility_status: "unverified", open_status: "unverified", link_status: "unverified", application_action: "none",
      identity_aliases: [], duplicate_count: 0, profile_id: "test", policy_fingerprint: "b".repeat(64),
    };
    list.mockResolvedValue({ candidates: [candidate], nextOffset: null, available: true });
    const html = await render();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Unknown; no date supplied");
    expect(html).toContain("Eligibility not verified");
    expect(html).toContain("Excluded role term");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("not newly posted by the employer");
    list.mockResolvedValue({ candidates: [{ ...candidate, url: "http://localhost" }], nextOffset: null, available: true });
    expect(await render()).toContain("No safe public HTTP(S) listing link supplied");
  });
});
