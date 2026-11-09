import { describe, expect, it } from "vitest";
import { classifyPostingUrl } from "@/lib/discovery/posting_url";

describe("SmartRecruiters posting classification", () => {
  it.each([
    "https://www.smartrecruiters.com/Acme/123456",
    "https://jobs.smartrecruiters.com/Acme/123456-senior-ai-engineer",
    "https://jobs.smartrecruiters.com/Acme/123456-engineer/?source=LinkedIn",
    "https://WWW.SMARTRECRUITERS.COM/Acme/123456",
  ])("recognizes numeric applicant postings: %s", (url) => {
    expect(classifyPostingUrl(url)).toMatchObject({ url_class: "DIRECT_POSTING", is_obviously_invalid: false });
  });

  it.each([
    "https://www.smartrecruiters.com/",
    "https://jobs.smartrecruiters.com/Acme?jobid=123",
    "https://www.smartrecruiters.com/Acme/senior-engineer",
    "https://www.smartrecruiters.com/Acme/123-extra/other",
    "https://www.smartrecruiters.com/Acme/123-",
    "https://careers.smartrecruiters.com/Acme",
    "https://careers.smartrecruiters.com/Acme/123456?jobid=123",
    "https://api.smartrecruiters.com/v1/companies/Acme/postings/123",
    "https://api.smartrecruiters.com/jobs/123456?jobid=123",
  ])("rejects landing pages and API destinations: %s", (url) => {
    expect(classifyPostingUrl(url).is_obviously_invalid).toBe(true);
  });

  it.each([
    "https://www.smartrecruiters.com.evil.test/Acme/123456",
    "https://fakesmartrecruiters.com/Acme/123456",
    "https://fakejobs.smartrecruiters.com/Acme/123456",
    "https://jobs.smartrecruiters.com@evil.test/Acme/123456",
  ])("does not trust lookalike hosts: %s", (url) => {
    expect(classifyPostingUrl(url).url_class).toBe("UNKNOWN");
  });
});
