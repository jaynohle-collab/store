import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeDescriptionHash,
  computeDiscoveryDescriptionHashes,
  computeDiscoveryDescriptionHashesSchema,
  DESCRIPTION_NORMALIZATION_VERSION,
  MAX_DESCRIPTION_BYTES,
  MAX_DESCRIPTION_BYTES_TOTAL,
  MAX_DESCRIPTION_HASH_ITEMS,
  normalizeDescriptionForHash,
  utf8ByteLength,
} from "@/lib/discovery/description_hash";
import {
  DEFAULT_GPT_EVALUATION_VERSION,
  discoveryGptEvaluationRecordSchema,
  discoveryPreflightVersionConfig,
  discoveryQualityGatesRequireStoredEvidence,
  GPT_FIT_V2,
  isDiscoveryGptEvaluationRequired,
} from "@/lib/discovery/gpt_evaluation";
import { classifyPostingUrl, isMalformedJobUrl } from "@/lib/discovery/posting_url";
import { normalizeJobUrl } from "@/lib/discovery/normalize";
import { resolveDiscoveryPreflightResults, emptyPreflightIndex } from "@/lib/discovery/preflight";
import {
  DiscoveryGptEvaluationConflictError,
  getMemoryDiscoveryGptEvaluations,
  recordDiscoveryEvaluations,
  resetInMemoryDiscoveryGptEvaluations,
  setMemoryGptEvaluationInsertDelayMs,
  useInMemoryDiscoveryGptEvaluations,
} from "@/lib/db/discovery_gpt_evaluations";
import {
  assertDiscoveryJobsGptAdmissionGate,
  discoveryJobSchema,
  submitDiscoveryBatchSchema,
} from "@/lib/db/inbox";
import { TOOL_PERMISSIONS } from "@/lib/config";
import { registerJobTools } from "@/lib/mcp/tools";
import type { McpServer } from "@modelcontextprotocol/server";

const HASH_A = "3406d8a6ef8edfbe";
const VALID_ASHBY =
  "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555";

function validV2Evaluation(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    client_evaluation_id: randomUUID(),
    client_candidate_id: "c1",
    company: "Acme",
    title: "Staff AI Engineer",
    url: VALID_ASHBY,
    source: "ashby",
    external_job_id: "REQ-1",
    location: "United States (Remote)",
    description_hash: HASH_A,
    gpt_relevance_score: 82,
    gpt_decision: "QUALIFIED",
    reasoning_summary: "US nationwide remote AI platform role.",
    evaluation_version: GPT_FIT_V2,
    remote_scope: "US_NATIONWIDE",
    direct_posting_url_verified: true,
    normalization_version: DESCRIPTION_NORMALIZATION_VERSION,
    posting_status: "OPEN",
    posting_status_verified_at: "2026-08-24T14:00:00.000Z",
    ...overrides,
  };
}

const VALID_JOB = {
  company: "Acme",
  title: "Staff AI Engineer",
  url: VALID_ASHBY,
  location: "United States",
  source: "ashby",
  description: "Build production LLM agents.",
  required_skills: ["Python"],
  preferred_skills: [] as string[],
  remote_status: "Remote" as const,
  salary: "$220k",
  posted_date: "2026-08-16",
};

describe("description hash Python parity", () => {
  it("matches committed cross-language fixtures", () => {
    const fixturePath = path.resolve(
      __dirname,
      "./fixtures/description_hash_parity.json",
    );
    const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
      description: string;
      normalized: string;
      description_hash: string | null;
    }>;
    for (const row of fixtures) {
      expect(normalizeDescriptionForHash(row.description)).toBe(row.normalized);
      expect(computeDescriptionHash(row.description)).toBe(row.description_hash);
    }
  });

  it("returns 16 lowercase hex or null", () => {
    expect(computeDescriptionHash("Build production LLM agents.")).toMatch(/^[a-f0-9]{16}$/);
    expect(computeDescriptionHash("   ")).toBeNull();
  });

  it("preserves input order and does not store descriptions", () => {
    const result = computeDiscoveryDescriptionHashes({
      items: [
        { client_candidate_id: "b", description: "Second role." },
        { client_candidate_id: "a", description: "First role." },
      ],
    });
    expect(result.results.map((r) => r.client_candidate_id)).toEqual(["b", "a"]);
    expect(result.results[0].normalization_version).toBe(DESCRIPTION_NORMALIZATION_VERSION);
    expect(JSON.stringify(result)).not.toMatch(/First role/);
  });

  it("enforces item and payload size limits", () => {
    expect(() => computeDiscoveryDescriptionHashesSchema.parse({ items: [] })).toThrow();
    expect(() =>
      computeDiscoveryDescriptionHashesSchema.parse({
        items: Array.from({ length: MAX_DESCRIPTION_HASH_ITEMS + 1 }, (_, i) => ({
          client_candidate_id: `c${i}`,
          description: "Job.",
        })),
      }),
    ).toThrow();
  });
});

describe("posting URL classification", () => {
  it("rejects careers homepages and jobs landings", () => {
    expect(classifyPostingUrl("https://acme.com/careers").url_class).toBe("CAREERS_HOME");
    expect(classifyPostingUrl("https://acme.com/jobs").url_class).toBe("JOBS_LANDING");
    expect(classifyPostingUrl("https://acme.com/careers").is_obviously_invalid).toBe(true);
  });

  it("rejects search and listing pages", () => {
    expect(
      classifyPostingUrl("https://acme.com/jobs?query=engineer&location=nyc").url_class,
    ).toBe("SEARCH_OR_LISTING");
    expect(classifyPostingUrl("https://acme.com/careers/search").url_class).toBe(
      "SEARCH_OR_LISTING",
    );
  });

  it("accepts Ashby, Greenhouse, Lever, Workday, and company ATS URLs", () => {
    expect(classifyPostingUrl(VALID_ASHBY).url_class).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl("https://boards.greenhouse.io/acme/jobs/1234567").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Staff-Engineer",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(classifyPostingUrl("https://acme.com/careers/staff-ai-platform-42").url_class).toBe(
      "DIRECT_POSTING",
    );
    expect(
      classifyPostingUrl("https://jobs.ashbyhq.com/acme").is_obviously_invalid,
    ).toBe(true);
  });

  it("rejects category listing pages", () => {
    expect(
      classifyPostingUrl("https://acme.com/careers/department/engineering").url_class,
    ).toBe("CATEGORY");
  });
});

describe("gpt-fit-v2 schema rules", () => {
  it("accepts US nationwide remote QUALIFIED", () => {
    const parsed = discoveryGptEvaluationRecordSchema.parse(validV2Evaluation());
    expect(parsed.remote_scope).toBe("US_NATIONWIDE");
    expect(parsed.direct_posting_url_verified).toBe(true);
  });

  it.each([
    "HYBRID",
    "ONSITE",
    "NON_US",
    "US_RESTRICTED",
    "UNKNOWN",
  ] as const)("rejects QUALIFIED for remote_scope %s", (scope) => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({ remote_scope: scope, gpt_decision: "QUALIFIED" }),
      ),
    ).toThrow();
  });

  it.each([
    ["HYBRID", "hybrid role"],
    ["ONSITE", "onsite role"],
    ["NON_US", "non-US"],
    ["US_RESTRICTED", "restricted"],
    ["UNKNOWN", "unknown"],
  ] as const)("requires REJECTED_HARD_RULE for remote_scope %s", (scope, reasonNeedle) => {
    const parsed = discoveryGptEvaluationRecordSchema.parse(
      validV2Evaluation({
        remote_scope: scope,
        gpt_decision: "REJECTED_HARD_RULE",
        gpt_relevance_score: 0,
        hard_rejection_reason: `${reasonNeedle} ineligible under gpt-fit-v2`,
        direct_posting_url_verified: false,
      }),
    );
    expect(parsed.gpt_decision).toBe("REJECTED_HARD_RULE");
  });

  it("rejects QUALIFIED careers homepage even if GPT verified the URL", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({
          url: "https://acme.com/careers",
          direct_posting_url_verified: true,
        }),
      ),
    ).toThrow(/CAREERS_HOME|not a direct/i);
  });

  it("rejects QUALIFIED gpt-fit-v2 with an empty description hash", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({ description_hash: "" }),
      ),
    ).toThrow(/description_hash/i);
  });

  it("does not rewrite gpt-fit-v1 records", () => {
    const parsed = discoveryGptEvaluationRecordSchema.parse({
      client_evaluation_id: randomUUID(),
      client_candidate_id: "c1",
      company: "Acme",
      title: "Staff AI Engineer",
      url: VALID_ASHBY,
      source: "ashby",
      gpt_relevance_score: 80,
      gpt_decision: "QUALIFIED",
      reasoning_summary: "legacy v1",
      evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(parsed.evaluation_version).toBe("gpt-fit-v1");
    expect(parsed.remote_scope).toBeUndefined();
  });
});

describe("record_discovery_evaluations gpt-fit-v2 persistence", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
  });

  it("stores QUALIFIED v2 evidence with remote and URL fields", async () => {
    const result = await recordDiscoveryEvaluations({
      evaluations: [validV2Evaluation()] as never,
    });
    expect(result.evaluations[0].remote_scope).toBe("US_NATIONWIDE");
    expect(result.evaluations[0].direct_posting_url_verified).toBe(true);
    expect(result.evaluations[0].normalization_version).toBe(DESCRIPTION_NORMALIZATION_VERSION);
  });

  it("records rejected evaluations for audit", async () => {
    await recordDiscoveryEvaluations({
      evaluations: [
        validV2Evaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
          remote_scope: "HYBRID",
          hard_rejection_reason: "hybrid role; gpt-fit-v2 requires fully remote US nationwide",
          direct_posting_url_verified: true,
        }),
      ] as never,
    });
    expect(getMemoryDiscoveryGptEvaluations()[0].gpt_decision).toBe("REJECTED_HARD_RULE");
  });

  it("is idempotent on identical client_evaluation_id retry", async () => {
    const payload = validV2Evaluation();
    const first = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    const second = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    expect(second.evaluations[0].evaluation_id).toBe(first.evaluations[0].evaluation_id);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });

  it("rejects a conflicting payload for the same client_evaluation_id", async () => {
    const payload = validV2Evaluation();
    await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    await expect(
      recordDiscoveryEvaluations({
        evaluations: [
          validV2Evaluation({
            client_evaluation_id: payload.client_evaluation_id,
            gpt_relevance_score: 91,
          }),
        ] as never,
      }),
    ).rejects.toThrow(DiscoveryGptEvaluationConflictError);
  });
});

describe("submit_discovery_batch quality gates", () => {
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
    for (const key of [
      "DISCOVERY_REQUIRE_GPT_EVALUATION",
      "DISCOVERY_REQUIRED_EVALUATION_VERSION",
      "DISCOVERY_REQUIRE_REMOTE_US",
      "DISCOVERY_REQUIRE_DIRECT_POSTING_URL",
      "DISCOVERY_REQUIRE_DESCRIPTION_HASH",
    ]) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("remains backward-compatible when rollout flags are false", async () => {
    expect(isDiscoveryGptEvaluationRequired()).toBe(false);
    expect(submitDiscoveryBatchSchema.parse({ jobs: [VALID_JOB], source: "chatgpt" }).jobs).toHaveLength(
      1,
    );
    await expect(assertDiscoveryJobsGptAdmissionGate([VALID_JOB])).resolves.toBeUndefined();
  });

  it("rejects empty hash under hash enforcement", async () => {
    process.env.DISCOVERY_REQUIRE_DESCRIPTION_HASH = "true";
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        validV2Evaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
          remote_scope: "HYBRID",
          description_hash: "",
          hard_rejection_reason: "hybrid",
          direct_posting_url_verified: false,
        }),
      ] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow();
  });

  it("rejects version mismatch when version is pinned", async () => {
    process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION = GPT_FIT_V2;
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        {
          client_evaluation_id: randomUUID(),
          client_candidate_id: "c1",
          company: "Acme",
          title: "Staff AI Engineer",
          url: VALID_ASHBY,
          source: "ashby",
          gpt_relevance_score: 80,
          gpt_decision: "QUALIFIED",
          reasoning_summary: "v1",
          evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        },
      ] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 80,
            gpt_decision: "QUALIFIED",
            evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
          },
        },
      ]),
    ).rejects.toThrow(/gpt-fit-v2/i);
  });

  it("rejects stored-evidence identity mismatch", async () => {
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [validV2Evaluation({ url: "https://jobs.ashbyhq.com/other/abcdef12-1234-1234-1234-abcdef123456" })] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow(/identity/i);
  });

  it("accepts stored QUALIFIED v2 when quality flags are enabled", async () => {
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
    process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION = GPT_FIT_V2;
    process.env.DISCOVERY_REQUIRE_REMOTE_US = "true";
    process.env.DISCOVERY_REQUIRE_DIRECT_POSTING_URL = "true";
    process.env.DISCOVERY_REQUIRE_DESCRIPTION_HASH = "true";
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [validV2Evaluation()] as never,
    });
    const job = discoveryJobSchema.parse({
      ...VALID_JOB,
      gpt_evaluation: {
        evaluation_id: String(recorded.evaluations[0].evaluation_id),
        gpt_relevance_score: 82,
        gpt_decision: "QUALIFIED",
        evaluation_version: GPT_FIT_V2,
        description_hash: HASH_A,
        remote_scope: "US_NATIONWIDE",
        direct_posting_url_verified: true,
        normalization_version: DESCRIPTION_NORMALIZATION_VERSION,
        posting_status: "OPEN",
      },
    });
    await expect(assertDiscoveryJobsGptAdmissionGate([job])).resolves.toBeUndefined();
  });
});

describe("preflight gpt-fit-v2 reuse and version isolation", () => {
  it("does not reuse gpt-fit-v1 evidence when gpt-fit-v2 is requested", () => {
    const index = emptyPreflightIndex();
    const url = VALID_ASHBY;
    const normalized = normalizeJobUrl(url);
    if (!normalized) throw new Error("expected normalized url");
    index.postingsByNormalizedUrl.set(normalized, {
      id: "post-1",
      canonical_job_id: "canon-1",
      source: "ashby",
      external_job_id: "REQ-1",
      url,
      normalized_url: normalized,
      description_hash: HASH_A,
      location: null,
    });
    index.gptByNormalizedUrl.set(normalized, {
      evaluation_id: randomUUID(),
      gpt_relevance_score: 80,
      gpt_decision: "QUALIFIED",
      hard_rejection_reason: null,
      reasoning_summary: "legacy v1",
      evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
      description_hash: HASH_A,
      remote_scope: null,
      direct_posting_url_verified: null,
      normalization_version: null,
      evaluated_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      normalized_url: normalized,
      source: "ashby",
      external_job_id: "REQ-1",
    });
    const [result] = resolveDiscoveryPreflightResults(
      [
        {
          client_candidate_id: "c1",
          company: "Acme",
          title: "Staff AI Engineer",
          url,
          source: "ashby",
          external_job_id: "REQ-1",
          location: "",
          posted_date: "",
          description_hash: HASH_A,
        },
      ],
      index,
      { evaluation_version: GPT_FIT_V2 },
    );
    expect(result.matched_by).toBe("normalized_url");
    expect(result.gpt_reevaluation_required).toBe(true);
    expect(result.gpt_reuse_allowed).toBe(false);
    expect(result.gpt_skip_allowed).toBe(false);
    expect(result.posting_url_class).toBe("DIRECT_POSTING");
  });
});

describe("tool registration", () => {
  it("registers hash and record tools with expected permissions", () => {
    const tools: Record<string, { config: Record<string, unknown> }> = {};
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        tools[name] = { config };
      },
    } as unknown as McpServer;
    registerJobTools(server);
    expect(tools.compute_discovery_description_hashes).toBeTruthy();
    expect(tools.record_discovery_evaluations).toBeTruthy();
    expect(TOOL_PERMISSIONS.compute_discovery_description_hashes).toBe("jobs:read");
    expect(String(tools.compute_discovery_description_hashes.config.description)).toMatch(
      /does not store/i,
    );
    const annotations = tools.compute_discovery_description_hashes.config.annotations as Record<
      string,
      unknown
    >;
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.idempotentHint).toBe(true);
  });
});

describe("gpt-fit-v2 posting_status", () => {
  it("accepts OPEN with a verified timestamp for QUALIFIED", () => {
    const parsed = discoveryGptEvaluationRecordSchema.parse(validV2Evaluation());
    expect(parsed.posting_status).toBe("OPEN");
    expect(parsed.posting_status_verified_at).toBe("2026-08-24T14:00:00.000Z");
  });

  it.each(["CLOSED", "UNKNOWN"] as const)("requires REJECTED_HARD_RULE for posting_status %s", (status) => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({ posting_status: status, gpt_decision: "QUALIFIED" }),
      ),
    ).toThrow();
    const parsed = discoveryGptEvaluationRecordSchema.parse(
      validV2Evaluation({
        posting_status: status,
        gpt_decision: "REJECTED_HARD_RULE",
        gpt_relevance_score: 0,
        hard_rejection_reason: `${status} posting is not an open job`,
        direct_posting_url_verified: false,
      }),
    );
    expect(parsed.gpt_decision).toBe("REJECTED_HARD_RULE");
  });

  it("rejects QUALIFIED without posting_status_verified_at", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({ posting_status_verified_at: null }),
      ),
    ).toThrow(/posting_status_verified_at/i);
  });
});

describe("URL classifier adversarial cases", () => {
  it("accepts query-based, UUID, slug, encoded, trailing-slash, and tracking URLs", () => {
    expect(
      classifyPostingUrl("https://acme.com/jobs?gh_jid=1234567").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555/",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl("https://acme.com/careers/staff-software-engineer").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl("https://acme.com/jobs/staff-ai-engineer%2Fplatform").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555?utm_source=linkedin",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl("https://acme.com/jobs/staff-ai-engineer/").url_class,
    ).toBe("DIRECT_POSTING");
  });

  it("does not require a numeric id for custom employer postings", () => {
    expect(
      classifyPostingUrl("https://acme.com/careers/staff-ai-platform-role").url_class,
    ).toBe("DIRECT_POSTING");
  });

  it("keeps careers homepages with misleading query params as CAREERS_HOME", () => {
    const classified = classifyPostingUrl("https://acme.com/careers?job_id=1&utm_source=li");
    expect(classified.url_class).toBe("CAREERS_HOME");
    expect(classified.is_obviously_invalid).toBe(true);
  });

  it("classifies malformed URLs as UNKNOWN rather than MISSING_POSTING_ID", () => {
    const classified = classifyPostingUrl("not a url");
    expect(classified.url_class).toBe("UNKNOWN");
    expect(classified.is_obviously_invalid).toBe(false);
    expect(isMalformedJobUrl("not a url")).toBe(true);
  });

  it("accepts Greenhouse regional domains, Workday requisitions, Ashby UUIDs, and Lever UUIDs", () => {
    expect(
      classifyPostingUrl("https://job-boards.greenhouse.io/acme/jobs/1234567").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl("https://boards.eu.greenhouse.io/acme/jobs/1234567").url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Staff-Engineer_R12345",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ).url_class,
    ).toBe("DIRECT_POSTING");
    expect(
      classifyPostingUrl(
        "https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ).url_class,
    ).toBe("DIRECT_POSTING");
  });

  it("uses MISSING_POSTING_ID only for recognized ATS landings", () => {
    expect(classifyPostingUrl("https://jobs.ashbyhq.com/acme").url_class).toBe("JOBS_LANDING");
    expect(classifyPostingUrl("https://boards.greenhouse.io/acme/jobs").url_class).toBe(
      "JOBS_LANDING",
    );
    expect(classifyPostingUrl("https://boards.greenhouse.io/acme/jobs/apply").url_class).toBe(
      "MISSING_POSTING_ID",
    );
    expect(classifyPostingUrl("https://unknown-employer.example/open-roles/foo").url_class).toBe(
      "UNKNOWN",
    );
  });

  it("does not let verified=true override a deterministic careers homepage", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({
          url: "https://acme.com/careers",
          direct_posting_url_verified: true,
        }),
      ),
    ).toThrow(/CAREERS_HOME|not a direct|classified/i);
  });

  it("rejects QUALIFIED malformed URLs even if GPT marked them verified", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validV2Evaluation({
          url: "http://[not-a-url",
          direct_posting_url_verified: true,
        }),
      ),
    ).toThrow(/parseable|malformed|classified/i);
  });
});

describe("UTF-8 description size limits", () => {
  it("allows ASCII and multibyte content under the byte cap", () => {
    expect(
      computeDiscoveryDescriptionHashesSchema.safeParse({
        items: [{ client_candidate_id: "a", description: "Build production LLM agents." }],
      }).success,
    ).toBe(true);
    const accented = "Ã©".repeat(50_000);
    expect(utf8ByteLength(accented)).toBe(100_000);
    expect(
      computeDiscoveryDescriptionHashesSchema.safeParse({
        items: [{ client_candidate_id: "a", description: accented }],
      }).success,
    ).toBe(true);
  });

  it("rejects a description just over the UTF-8 byte cap", () => {
    const over = "Ã©".repeat(50_001);
    expect(utf8ByteLength(over)).toBeGreaterThan(MAX_DESCRIPTION_BYTES);
    expect(
      computeDiscoveryDescriptionHashesSchema.safeParse({
        items: [{ client_candidate_id: "a", description: over }],
      }).success,
    ).toBe(false);
  });

  it("rejects emoji batches that exceed the aggregate UTF-8 byte cap", () => {
    const chunk = "ðŸ˜€".repeat(20_000);
    expect(utf8ByteLength(chunk) * 6).toBeGreaterThan(MAX_DESCRIPTION_BYTES_TOTAL);
    expect(
      computeDiscoveryDescriptionHashesSchema.safeParse({
        items: Array.from({ length: 6 }, (_, i) => ({
          client_candidate_id: `c${i}`,
          description: chunk,
        })),
      }).success,
    ).toBe(false);
  });

  it("returns null when normalized content is empty", () => {
    expect(computeDescriptionHash("!!!")).toBeNull();
    expect(computeDiscoveryDescriptionHashes({
      items: [{ client_candidate_id: "c1", description: "***" }],
    }).results[0].description_hash).toBeNull();
  });
});

describe("quality-flag dependency safety", () => {
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
    for (const key of [
      "DISCOVERY_REQUIRE_GPT_EVALUATION",
      "DISCOVERY_REQUIRED_EVALUATION_VERSION",
      "DISCOVERY_REQUIRE_REMOTE_US",
      "DISCOVERY_REQUIRE_DIRECT_POSTING_URL",
      "DISCOVERY_REQUIRE_DESCRIPTION_HASH",
    ]) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ["DISCOVERY_REQUIRED_EVALUATION_VERSION", "gpt-fit-v2"],
    ["DISCOVERY_REQUIRE_REMOTE_US", "true"],
    ["DISCOVERY_REQUIRE_DIRECT_POSTING_URL", "true"],
    ["DISCOVERY_REQUIRE_DESCRIPTION_HASH", "true"],
  ] as const)("requires stored evidence when %s is set and GPT enforcement is off", async (flag, value) => {
    delete process.env.DISCOVERY_REQUIRE_GPT_EVALUATION;
    process.env[flag] = value;
    expect(isDiscoveryGptEvaluationRequired()).toBe(false);
    expect(discoveryQualityGatesRequireStoredEvidence()).toBe(true);
    await expect(assertDiscoveryJobsGptAdmissionGate([VALID_JOB])).rejects.toThrow(
      /gpt_evaluation/i,
    );
  });

  it("keeps existing GPT enforcement on while v2 flags stay off", async () => {
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
    await expect(assertDiscoveryJobsGptAdmissionGate([VALID_JOB])).rejects.toThrow(
      /gpt_evaluation/i,
    );
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        {
          client_evaluation_id: randomUUID(),
          client_candidate_id: "c1",
          company: "Acme",
          title: "Staff AI Engineer",
          url: VALID_ASHBY,
          source: "ashby",
          gpt_relevance_score: 80,
          gpt_decision: "QUALIFIED",
          reasoning_summary: "v1 still valid",
          evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        },
      ] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 80,
            gpt_decision: "QUALIFIED",
            evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
          },
        },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("submit attachment mismatches", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
    process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION = GPT_FIT_V2;
  });

  afterEach(() => {
    delete process.env.DISCOVERY_REQUIRE_GPT_EVALUATION;
    delete process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION;
  });

  async function recordedV2() {
    return recordDiscoveryEvaluations({ evaluations: [validV2Evaluation()] as never });
  }

  it("rejects unknown evaluation id", async () => {
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: randomUUID(),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow(/unknown evaluation_id/i);
  });

  it("rejects normalized URL identity mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          url: "https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow(/identity does not match/i);
  });

  it("rejects decision mismatch against non-QUALIFIED stored evidence", async () => {
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        validV2Evaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
          hard_rejection_reason: "closed posting",
          direct_posting_url_verified: false,
          posting_status: "CLOSED",
        }),
      ] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow(/non-QUALIFIED/i);
  });

  it("rejects evaluation_version mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
          },
        },
      ]),
    ).rejects.toThrow(/evaluation_version/i);
  });

  it("rejects score mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 90,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).rejects.toThrow(/gpt_relevance_score/i);
  });

  it("rejects description_hash mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
            description_hash: "aaaaaaaaaaaaaaaa",
          },
        },
      ]),
    ).rejects.toThrow(/description_hash/i);
  });

  it("rejects normalization_version mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
            normalization_version: "other-v1",
          },
        },
      ]),
    ).rejects.toThrow(/normalization_version/i);
  });

  it("rejects remote_scope mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
            remote_scope: "HYBRID",
          },
        },
      ]),
    ).rejects.toThrow(/remote_scope/i);
  });

  it("rejects direct_posting_url_verified mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
            direct_posting_url_verified: false,
          },
        },
      ]),
    ).rejects.toThrow(/direct_posting_url_verified/i);
  });

  it("rejects posting_status mismatch", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
            posting_status: "CLOSED",
          },
        },
      ]),
    ).rejects.toThrow(/posting_status/i);
  });

  it("treats tracking-parameter URLs as the same normalized identity", async () => {
    const recorded = await recordedV2();
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          url: `${VALID_ASHBY}?utm_source=linkedin`,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 82,
            gpt_decision: "QUALIFIED",
            evaluation_version: GPT_FIT_V2,
          },
        },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("v2 idempotency fingerprint", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
    setMemoryGptEvaluationInsertDelayMs(0);
  });

  afterEach(() => {
    setMemoryGptEvaluationInsertDelayMs(0);
  });

  it("returns the same evaluation_id for identical retries", async () => {
    const payload = validV2Evaluation();
    const first = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    const second = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    expect(second.evaluations[0].evaluation_id).toBe(first.evaluations[0].evaluation_id);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });

  it("conflicts when posting_status changes for the same client_evaluation_id", async () => {
    const payload = validV2Evaluation();
    await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    await expect(
      recordDiscoveryEvaluations({
        evaluations: [
          validV2Evaluation({
            client_evaluation_id: payload.client_evaluation_id,
            posting_status: "CLOSED",
            gpt_decision: "REJECTED_HARD_RULE",
            gpt_relevance_score: 0,
            hard_rejection_reason: "closed",
            direct_posting_url_verified: false,
          }),
        ] as never,
      }),
    ).rejects.toThrow(DiscoveryGptEvaluationConflictError);
  });

  it("is concurrent-safe for identical v2 retries", async () => {
    const payload = validV2Evaluation();
    setMemoryGptEvaluationInsertDelayMs(20);
    const results = await Promise.all([
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
    ]);
    const ids = new Set(results.map((row) => String(row.evaluations[0].evaluation_id)));
    expect(ids.size).toBe(1);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });
});

describe("preflight version configuration", () => {
  const previous = process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION;

  afterEach(() => {
    if (previous === undefined) delete process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION;
    else process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION = previous;
  });

  it("defaults to gpt-fit-v1 and surfaces a required v2 pin", () => {
    delete process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION;
    expect(discoveryPreflightVersionConfig(undefined)).toEqual({
      requested_evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
      default_evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
      required_evaluation_version: null,
    });
    process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION = GPT_FIT_V2;
    const pinned = discoveryPreflightVersionConfig(undefined);
    expect(pinned.requested_evaluation_version).toBe(DEFAULT_GPT_EVALUATION_VERSION);
    expect(pinned.required_evaluation_version).toBe(GPT_FIT_V2);
    expect(discoveryPreflightVersionConfig(GPT_FIT_V2).requested_evaluation_version).toBe(GPT_FIT_V2);
  });
});

describe("hash tool has no side effects", () => {
  it("does not import or invoke the database client", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../discovery/description_hash.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/getSql|INSERT|discovery_gpt_evaluations/);
    const result = computeDiscoveryDescriptionHashes({
      items: [{ client_candidate_id: "secret", description: "Confidential JD text." }],
    });
    expect(JSON.stringify(result)).not.toMatch(/Confidential JD text/);
    expect(result.results[0].client_candidate_id).toBe("secret");
    expect(result.results[0].description_hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("production rollout documentation", () => {
  it("documents never disabling existing GPT enforcement", () => {
    const readme = readFileSync(path.resolve(__dirname, "../../../../README.md"), "utf8");
    const envExample = readFileSync(
      path.resolve(__dirname, "../../../.env.example"),
      "utf8",
    );
    expect(readme).toMatch(/Keep `DISCOVERY_REQUIRE_GPT_EVALUATION=true`/);
    expect(readme).toMatch(/never temporarily disable/i);
    expect(readme).toMatch(/Configure all v2 settings together/);
    expect(envExample).toMatch(/never temporarily disable it during v2 rollout/i);
    expect(envExample).toMatch(/Set ALL v2 settings together/i);
  });
});
