import { describe, expect, it } from "vitest";

import { normalizeCompanyKey, normalizeJobUrl, normalizeTitleKey } from "@/lib/discovery/normalize";
import {
  checkDiscoveryCandidatesSchema,
  companyHashKey,
  companyTitleKey,
  emptyPreflightIndex,
  resolveDiscoveryPreflightResults,
  sourceExternalKey,
  type DiscoveryPreflightCandidate,
  type DiscoveryPreflightIndex,
  type PreflightCanonicalRow,
  type PreflightPostingRow,
} from "@/lib/discovery/preflight";

function candidate(
  overrides: Partial<DiscoveryPreflightCandidate> & Pick<
    DiscoveryPreflightCandidate,
    "client_candidate_id" | "company" | "title" | "url" | "source"
  >,
): DiscoveryPreflightCandidate {
  return {
    external_job_id: "",
    location: "",
    posted_date: "",
    description_hash: "",
    ...overrides,
  };
}

function posting(row: Partial<PreflightPostingRow> & Pick<PreflightPostingRow, "id" | "canonical_job_id">): PreflightPostingRow {
  return {
    source: null,
    external_job_id: null,
    url: null,
    normalized_url: null,
    description_hash: null,
    location: null,
    ...row,
  };
}

function indexWith(mutate: (index: DiscoveryPreflightIndex) => void): DiscoveryPreflightIndex {
  const index = emptyPreflightIndex();
  mutate(index);
  return index;
}

describe("discovery preflight identity resolution", () => {
  it("same normalized URL and same description hash returns KNOWN_UNCHANGED", () => {
    const existing = posting({
      id: "post-1",
      canonical_job_id: "canon-1",
      source: "ashby",
      url: "https://example.com/jobs/1?utm_source=x",
      normalized_url: normalizeJobUrl("https://example.com/jobs/1?utm_source=x"),
      description_hash: "hash-a",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set(existing.normalized_url!, existing);
      idx.evaluationsByPostingId.set("post-1", {
        posting_id: "post-1",
        match_score: 81,
        recommendation: "save",
        reason: "strong match",
        scoring_version: "profile-v1",
        profile_version: "jay-ai-v1",
      });
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c1",
          company: "Acme",
          title: "Staff Engineer",
          url: "https://example.com/jobs/1",
          source: "linkedin",
          description_hash: "hash-a",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("KNOWN_UNCHANGED");
    expect(result.matched_by).toBe("normalized_url");
    expect(result.posting_id).toBe("post-1");
    expect(result.prior_evaluation?.match_score).toBe(81);
  });

  it("same source and external ID returns KNOWN_UNCHANGED", () => {
    const existing = posting({
      id: "post-2",
      canonical_job_id: "canon-2",
      source: "greenhouse",
      external_job_id: "REQ-9",
      url: "https://boards.example.com/req-9",
      normalized_url: "https://boards.example.com/req-9",
      description_hash: "hash-b",
    });
    const index = indexWith((idx) => {
      idx.postingsBySourceExternal.set(sourceExternalKey("greenhouse", "REQ-9"), existing);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c2",
          company: "Acme",
          title: "Staff Engineer",
          url: "https://other.example.com/x",
          source: "greenhouse",
          external_job_id: "REQ-9",
          description_hash: "",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("KNOWN_UNCHANGED");
    expect(result.matched_by).toBe("source_external_id");
    expect(result.existing_description_hash).toBe("hash-b");
  });

  it("deterministic identity with changed description hash returns UPDATED_POSTING", () => {
    const existing = posting({
      id: "post-3",
      canonical_job_id: "canon-3",
      source: "ashby",
      url: "https://example.com/jobs/3",
      normalized_url: "https://example.com/jobs/3",
      description_hash: "old-hash",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/jobs/3", existing);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c3",
          company: "Acme",
          title: "Staff Engineer",
          url: "https://example.com/jobs/3",
          source: "ashby",
          description_hash: "new-hash",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("UPDATED_POSTING");
    expect(result.matched_by).toBe("normalized_url");
  });

  it("same opening signals on a different source return POSSIBLE_CROSS_SOURCE", () => {
    const companyKey = normalizeCompanyKey("AgentForge Inc");
    const titleKey = normalizeTitleKey("Staff AI Engineer, Agent Platform");
    const canonical: PreflightCanonicalRow = {
      id: "canon-4",
      company_key: companyKey,
      normalized_title: titleKey,
      location: "United States",
      normalized_location: "united states",
    };
    const related = posting({
      id: "post-4",
      canonical_job_id: "canon-4",
      source: "ashby",
      url: "https://jobs.ashbyhq.com/agentforge/abc",
      normalized_url: "https://jobs.ashbyhq.com/agentforge/abc",
      description_hash: "shared-hash",
      location: "United States",
    });
    const index = indexWith((idx) => {
      idx.canonicalsByCompanyTitle.set(companyTitleKey(companyKey, titleKey), [canonical]);
      idx.postingsByCanonicalId.set("canon-4", [related]);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c4",
          company: "AgentForge Inc",
          title: "Staff AI Engineer, Agent Platform",
          url: "https://www.linkedin.com/jobs/view/999",
          source: "linkedin",
          location: "United States",
          description_hash: "shared-hash",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("POSSIBLE_CROSS_SOURCE");
    expect(result.matched_by).toBe("canonical_signals");
    expect(result.canonical_job_id).toBe("canon-4");
    expect(result.prior_evaluation).toBeNull();
  });

  it("similar title but different requisition IDs are not automatically merged", () => {
    const companyKey = normalizeCompanyKey("Acme");
    const titleKey = normalizeTitleKey("Member of Technical Staff");
    const canonical: PreflightCanonicalRow = {
      id: "canon-5",
      company_key: companyKey,
      normalized_title: titleKey,
      location: null,
      normalized_location: null,
    };
    const existing = posting({
      id: "post-5",
      canonical_job_id: "canon-5",
      source: "greenhouse",
      external_job_id: "REQ-100",
      url: "https://boards.greenhouse.io/acme/jobs/100",
      normalized_url: "https://boards.greenhouse.io/acme/jobs/100",
    });
    const index = indexWith((idx) => {
      idx.postingsBySourceExternal.set(
        sourceExternalKey("greenhouse", "REQ-100"),
        existing,
      );
      idx.canonicalsByCompanyTitle.set(companyTitleKey(companyKey, titleKey), [canonical]);
      idx.postingsByCanonicalId.set("canon-5", [existing]);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c5",
          company: "Acme",
          title: "Member of Technical Staff",
          url: "https://boards.greenhouse.io/acme/jobs/200",
          source: "greenhouse",
          external_job_id: "REQ-200",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("POSSIBLE_CROSS_SOURCE");
    expect(result.matched_by).toBe("canonical_signals");
    expect(result.posting_id).not.toBeNull();
  });

  it("completely new candidate returns UNSEEN", () => {
    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c6",
          company: "Brand New Co",
          title: "Platform Engineer",
          url: "https://example.com/brand-new",
          source: "company_site",
        }),
      ],
      emptyPreflightIndex(),
    );
    expect(result.identity_status).toBe("UNSEEN");
    expect(result.matched_by).toBe("none");
    expect(result.posting_id).toBeNull();
  });

  it("existing application sets previously_applied", () => {
    const existing = posting({
      id: "post-7",
      canonical_job_id: "canon-7",
      source: "ashby",
      url: "https://example.com/jobs/7",
      normalized_url: "https://example.com/jobs/7",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/jobs/7", existing);
      idx.applicationsByPostingId.set("post-7", [
        { posting_id: "post-7", canonical_job_id: "canon-7", status: "applied" },
      ]);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c7",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/jobs/7",
          source: "ashby",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("KNOWN_UNCHANGED");
    expect(result.previously_applied).toBe(true);
  });

  it("latest evaluation is returned for an exact match", () => {
    const existing = posting({
      id: "post-8",
      canonical_job_id: "canon-8",
      source: "ashby",
      url: "https://example.com/jobs/8",
      normalized_url: "https://example.com/jobs/8",
      description_hash: "h8",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/jobs/8", existing);
      idx.evaluationsByPostingId.set("post-8", {
        posting_id: "post-8",
        match_score: 39,
        recommendation: "save",
        reason: "profile fit",
        scoring_version: "profile-v1",
        profile_version: "jay-ai-v1",
      });
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c8",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/jobs/8",
          source: "ashby",
          description_hash: "h8",
        }),
      ],
      index,
    );

    expect(result.prior_evaluation).toEqual({
      match_score: 39,
      recommendation: "save",
      reason: "profile fit",
      scoring_version: "profile-v1",
      profile_version: "jay-ai-v1",
    });
  });

  it("empty description hash is handled safely as KNOWN_UNCHANGED on identity match", () => {
    const existing = posting({
      id: "post-9",
      canonical_job_id: "canon-9",
      source: "ashby",
      url: "https://example.com/jobs/9",
      normalized_url: "https://example.com/jobs/9",
      description_hash: "stored-hash",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/jobs/9", existing);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c9",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/jobs/9",
          source: "ashby",
          description_hash: "",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("KNOWN_UNCHANGED");
    expect(result.existing_description_hash).toBe("stored-hash");
  });

  it("preserves input ordering", () => {
    const existing = posting({
      id: "post-a",
      canonical_job_id: "canon-a",
      url: "https://example.com/a",
      normalized_url: "https://example.com/a",
      source: "ashby",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/a", existing);
    });

    const results = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "second",
          company: "NewCo",
          title: "New Role",
          url: "https://example.com/new",
          source: "linkedin",
        }),
        candidate({
          client_candidate_id: "first",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/a",
          source: "ashby",
        }),
      ],
      index,
    );

    expect(results.map((r) => r.client_candidate_id)).toEqual(["second", "first"]);
    expect(results[0].identity_status).toBe("UNSEEN");
    expect(results[1].identity_status).toBe("KNOWN_UNCHANGED");
  });

  it("does not treat same external_job_id on a different source as source_external_id match", () => {
    const existing = posting({
      id: "post-ext",
      canonical_job_id: "canon-ext",
      source: "greenhouse",
      external_job_id: "SHARED-1",
      url: "https://boards.greenhouse.io/acme/jobs/1",
      normalized_url: "https://boards.greenhouse.io/acme/jobs/1",
    });
    const index = indexWith((idx) => {
      idx.postingsBySourceExternal.set(
        sourceExternalKey("greenhouse", "SHARED-1"),
        existing,
      );
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "cross-ext",
          company: "Other Co",
          title: "Unrelated Role",
          url: "https://www.linkedin.com/jobs/view/9999",
          source: "linkedin",
          external_job_id: "SHARED-1",
        }),
      ],
      index,
    );

    expect(result.matched_by).not.toBe("source_external_id");
    expect(result.identity_status).toBe("UNSEEN");
  });

  it("does not treat description_hash alone as posting identity", () => {
    const existing = posting({
      id: "post-hash",
      canonical_job_id: "canon-hash",
      source: "ashby",
      url: "https://example.com/jobs/hash",
      normalized_url: "https://example.com/jobs/hash",
      description_hash: "lonely-hash",
    });
    const index = indexWith((idx) => {
      // Hash index under a different company — candidate company won't match.
      idx.postingsByCompanyHash.set(
        companyHashKey("otherco", "lonely-hash"),
        [existing],
      );
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "hash-only",
          company: "Brand New Co",
          title: "Platform Engineer",
          url: "https://example.com/brand-new-hash",
          source: "linkedin",
          description_hash: "lonely-hash",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("UNSEEN");
    expect(result.matched_by).toBe("none");
  });

  it("keeps previously_applied as an overlay without changing identity status", () => {
    const existing = posting({
      id: "post-overlay",
      canonical_job_id: "canon-overlay",
      source: "ashby",
      url: "https://example.com/jobs/overlay",
      normalized_url: "https://example.com/jobs/overlay",
      description_hash: "old",
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set("https://example.com/jobs/overlay", existing);
      idx.applicationsByPostingId.set("post-overlay", [
        {
          posting_id: "post-overlay",
          canonical_job_id: "canon-overlay",
          status: "applied",
        },
      ]);
    });

    const [result] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "overlay",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/jobs/overlay",
          source: "ashby",
          description_hash: "new",
        }),
      ],
      index,
    );

    expect(result.identity_status).toBe("UPDATED_POSTING");
    expect(result.previously_applied).toBe(true);
  });
});

describe("URL normalization for preflight", () => {
  it("strips only tracking params and lowercases host deterministically", () => {
    expect(
      normalizeJobUrl("https://Example.COM/jobs/1/?utm_source=x&utm_campaign=y&id=42"),
    ).toBe("https://example.com/jobs/1?id=42");
    expect(normalizeJobUrl("https://example.com/jobs/1?ref=track&source=share")).toBe(
      "https://example.com/jobs/1",
    );
  });

  it("encodes query spaces like Python quote_plus", () => {
    expect(normalizeJobUrl("https://example.com/search?q=machine learning")).toBe(
      "https://example.com/search?q=machine+learning",
    );
  });
});

describe("discovery preflight schema", () => {
  it("rejects more than 100 candidates", () => {
    const candidates = Array.from({ length: 101 }, (_, i) =>
      candidate({
        client_candidate_id: `c${i}`,
        company: "Acme",
        title: "Engineer",
        url: `https://example.com/${i}`,
        source: "ashby",
      }),
    );
    const parsed = checkDiscoveryCandidatesSchema.safeParse({ candidates });
    expect(parsed.success).toBe(false);
  });

  it("rejects score, recommendation, and reasoning fields", () => {
    const withScore = checkDiscoveryCandidatesSchema.safeParse({
      candidates: [
        {
          ...candidate({
            client_candidate_id: "bad",
            company: "Acme",
            title: "Engineer",
            url: "https://example.com/bad",
            source: "ashby",
          }),
          match_score: 90,
        },
      ],
    });
    expect(withScore.success).toBe(false);

    const withRecommendation = checkDiscoveryCandidatesSchema.safeParse({
      candidates: [
        {
          ...candidate({
            client_candidate_id: "bad2",
            company: "Acme",
            title: "Engineer",
            url: "https://example.com/bad2",
            source: "ashby",
          }),
          recommendation: "save",
        },
      ],
    });
    expect(withRecommendation.success).toBe(false);

    const withReasoning = checkDiscoveryCandidatesSchema.safeParse({
      candidates: [
        {
          ...candidate({
            client_candidate_id: "bad3",
            company: "Acme",
            title: "Engineer",
            url: "https://example.com/bad3",
            source: "ashby",
          }),
          reasoning: "looks good",
        },
      ],
    });
    expect(withReasoning.success).toBe(false);

    const withDisposition = checkDiscoveryCandidatesSchema.safeParse({
      candidates: [
        {
          ...candidate({
            client_candidate_id: "bad4",
            company: "Acme",
            title: "Engineer",
            url: "https://example.com/bad4",
            source: "ashby",
          }),
          disposition: "NEW_JOB",
        },
      ],
    });
    expect(withDisposition.success).toBe(false);
  });
});

describe("check_discovery_candidates MCP registration", () => {
  it("registers as read-only jobs:read without mutating lifecycle tools", async () => {
    const { registerJobTools } = await import("@/lib/mcp/tools");
    const { TOOL_PERMISSIONS } = await import("@/lib/config");
    type ToolHandler = (
      args: Record<string, unknown>,
      extra: { http: { authInfo: { token: string; clientId: string; scopes: string[] } } },
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    const tools: Record<string, { config: Record<string, unknown>; handler: ToolHandler }> = {};
    const server = {
      registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler) {
        tools[name] = { config, handler };
      },
    };
    registerJobTools(server as never);

    expect(tools.check_discovery_candidates).toBeTruthy();
    expect(tools.save_canonical_job).toBeTruthy();
    expect(TOOL_PERMISSIONS.check_discovery_candidates).toBe("jobs:read");
    expect(tools.check_discovery_candidates.config.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(String(tools.check_discovery_candidates.config.description)).toMatch(/does not score/i);
  });
});
