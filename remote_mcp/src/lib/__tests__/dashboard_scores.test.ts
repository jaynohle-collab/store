import { describe, expect, it } from "vitest";

import {
  GPT_FIT_LABEL,
  PYTHON_RANK_LABEL,
  formatGptFit,
  formatPythonRank,
  selectLatestGptEvidence,
} from "@/lib/dashboard/scores";

describe("dashboard score labeling", () => {
  it("keeps Python Rank and GPT Fit labels distinct", () => {
    expect(PYTHON_RANK_LABEL).toBe("Rank");
    expect(GPT_FIT_LABEL).toBe("GPT Fit");
    expect(PYTHON_RANK_LABEL).not.toBe(GPT_FIT_LABEL);
  });

  it("formats scores independently", () => {
    expect(formatPythonRank(82.4)).toBe("82");
    expect(formatGptFit(77.1)).toBe("77");
    expect(formatPythonRank(null)).toBe("—");
    expect(formatGptFit(undefined)).toBe("—");
  });

  it("selects latest GPT evidence preferring required version then created_at/id", () => {
    const chosen = selectLatestGptEvidence(
      [
        {
          id: "1",
          gpt_relevance_score: 90,
          evaluation_version: "gpt-fit-v1",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "2",
          gpt_relevance_score: 80,
          evaluation_version: "gpt-fit-v2",
          created_at: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "3",
          gpt_relevance_score: 95,
          evaluation_version: "gpt-fit-v2",
          created_at: "2026-08-03T00:00:00.000Z",
        },
      ],
      "gpt-fit-v2",
    );
    expect(chosen?.id).toBe("3");
    expect(chosen?.gpt_relevance_score).toBe(95);
  });

  it("orders by created_at and id when versions tie", () => {
    const chosen = selectLatestGptEvidence(
      [
        {
          id: "aaa",
          gpt_relevance_score: 70,
          evaluation_version: "gpt-fit-v1",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "bbb",
          gpt_relevance_score: 71,
          evaluation_version: "gpt-fit-v1",
          created_at: "2026-08-02T00:00:00.000Z",
        },
      ],
      null,
    );
    expect(chosen?.id).toBe("bbb");
  });
});
