import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HIGH_MATCH_THRESHOLD,
  isHighMatch,
  isToApplyEligible,
  selectToApplyJobs,
  TO_APPLY_RECOMMENDATIONS,
} from "@/lib/dashboard/constants";

const dashboardSqlSource = readFileSync(
  path.resolve(__dirname, "../db/dashboard.ts"),
  "utf8",
);
const toApplyPageSource = readFileSync(
  path.resolve(__dirname, "../../app/dashboard/to-apply/page.tsx"),
  "utf8",
);

describe("To Apply eligibility (recommendation-based)", () => {
  it("includes active save recommendation below the high-match threshold", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "save",
        match_score: 39,
        application_id: null,
      }),
    ).toBe(true);
  });

  it("includes active save_repost recommendation below threshold", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "save_repost",
        match_score: 55,
        application_id: null,
      }),
    ).toBe(true);
  });

  it("excludes a posting that already has an application", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "save",
        match_score: 90,
        application_id: "app-1",
      }),
    ).toBe(false);
  });

  it("excludes ignored and closed postings", () => {
    expect(
      isToApplyEligible({
        posting_status: "ignored",
        recommendation: "save",
        match_score: 90,
        application_id: null,
      }),
    ).toBe(false);
    expect(
      isToApplyEligible({
        posting_status: "closed",
        recommendation: "save_repost",
        match_score: 90,
        application_id: null,
      }),
    ).toBe(false);
  });

  it("excludes discard / update_existing recommendations", () => {
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "discard",
        match_score: 90,
        application_id: null,
      }),
    ).toBe(false);
    expect(
      isToApplyEligible({
        posting_status: "active",
        recommendation: "update_existing",
        match_score: 90,
        application_id: null,
      }),
    ).toBe(false);
  });

  it("sorts To Apply jobs by match score descending", () => {
    const selected = selectToApplyJobs([
      {
        id: "low",
        posting_status: "active",
        recommendation: "save",
        match_score: 39,
        application_id: null,
      },
      {
        id: "high",
        posting_status: "active",
        recommendation: "save_repost",
        match_score: 82,
        application_id: null,
      },
      {
        id: "mid",
        posting_status: "active",
        recommendation: "save",
        match_score: 61,
        application_id: null,
      },
      {
        id: "applied",
        posting_status: "active",
        recommendation: "save",
        match_score: 99,
        application_id: "app-9",
      },
    ]);
    expect(selected.map((j) => j.id)).toEqual(["high", "mid", "low"]);
    expect(selected.map((j) => j.match_score)).toEqual([82, 61, 39]);
  });

  it("keeps High Match counts on threshold 70", () => {
    expect(DEFAULT_HIGH_MATCH_THRESHOLD).toBe(70);
    expect(isHighMatch(69)).toBe(false);
    expect(isHighMatch(70)).toBe(true);
    expect(isHighMatch(39)).toBe(false);
    expect(isHighMatch(90)).toBe(true);
  });
});

describe("To Apply SQL / copy policy", () => {
  it("uses save/save_repost for to-apply and keeps threshold only for high match / optional min_match", () => {
    expect(TO_APPLY_RECOMMENDATIONS).toEqual(["save", "save_repost"]);
    expect(dashboardSqlSource).toContain("le.recommendation IN ('save', 'save_repost')");
    expect(dashboardSqlSource).not.toMatch(
      /toApply[\s\S]{0,200}le\.match_score IS NOT NULL AND le\.match_score >= \$\{p\.threshold\}/,
    );
    expect(dashboardSqlSource).toContain(
      "WHERE match_score IS NOT NULL AND match_score >= ${highMatchThreshold})",
    );
    expect(dashboardSqlSource).toContain("${p.minMatch}::numeric IS NULL OR");
  });

  it("does not claim To Apply requires the high-match threshold", () => {
    expect(toApplyPageSource).not.toMatch(/at\/above threshold/i);
    expect(toApplyPageSource).toMatch(/save or save_repost/i);
  });
});
