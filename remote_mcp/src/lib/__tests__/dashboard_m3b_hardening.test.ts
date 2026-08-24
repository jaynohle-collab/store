import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isToApplyEligible } from "@/lib/dashboard/constants";
import { selectLatestGptEvidence } from "@/lib/dashboard/scores";

describe("planned application semantics", () => {
  it("allows planned status on To Apply eligible postings", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "save",
        application_id: "app-1",
        application_status: "planned",
      }),
    ).toBe(true);
  });

  it("still excludes non-planned application statuses", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "save",
        application_id: "app-1",
        application_status: "applied",
      }),
    ).toBe(false);
  });
});

describe("GPT evidence selection hardening", () => {
  it("prefers required v2 over newer v1 row", () => {
    const chosen = selectLatestGptEvidence(
      [
        {
          id: "v1-new",
          evaluation_version: "gpt-fit-v1",
          gpt_relevance_score: 99,
          created_at: "2026-08-10T00:00:00.000Z",
        },
        {
          id: "v2-old",
          evaluation_version: "gpt-fit-v2",
          gpt_relevance_score: 80,
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      "gpt-fit-v2",
    );
    expect(chosen?.id).toBe("v2-old");
  });

  it("breaks equal timestamps by id descending", () => {
    const chosen = selectLatestGptEvidence(
      [
        {
          id: "aaa",
          evaluation_version: "gpt-fit-v2",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "bbb",
          evaluation_version: "gpt-fit-v2",
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      "gpt-fit-v2",
    );
    expect(chosen?.id).toBe("bbb");
  });

  it("returns null when no GPT evidence exists", () => {
    expect(selectLatestGptEvidence([], "gpt-fit-v2")).toBeNull();
  });
});

describe("stable sort tie-breakers", () => {
  it("uses posting id as deterministic secondary key in To Apply SQL", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../db/dashboard_to_apply.ts"),
      "utf8",
    );
    expect(source).toMatch(/ORDER BY[\s\S]+p\.id ASC/);
    expect(source).not.toContain("COUNT(*) OVER()");
    expect(source).toContain("SELECT COUNT(*)::int AS total");
  });

  it("uses application id tie-breaker in Applied SQL", () => {
    const source = readFileSync(path.resolve(__dirname, "../db/dashboard.ts"), "utf8");
    expect(source).toMatch(/listApplicationsPage[\s\S]+a\.id ASC/);
    expect(source).toContain("SELECT COUNT(*)::int AS total");
  });
});
