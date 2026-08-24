import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";

import { TOOL_PERMISSIONS } from "@/lib/config";
import {
  getMemoryDiscoveryGptEvaluations,
  loadLatestGptEvaluationsForPreflight,
  recordDiscoveryEvaluations,
  resetInMemoryDiscoveryGptEvaluations,
  setMemoryEvaluationCreatedAt,
  setMemoryGptEvaluationInsertDelayMs,
  useInMemoryDiscoveryGptEvaluations,
} from "@/lib/db/discovery_gpt_evaluations";
import {
  assertDiscoveryJobsGptAdmissionGate,
  discoveryJobSchema,
  submitDiscoveryBatchSchema,
} from "@/lib/db/inbox";
import {
  DEFAULT_GPT_EVALUATION_VERSION,
  discoveryGptEvaluationRecordSchema,
  recordDiscoveryEvaluationsSchema,
  resolveGptPreflightFields,
} from "@/lib/discovery/gpt_evaluation";
import { normalizeJobUrl } from "@/lib/discovery/normalize";
import {
  checkDiscoveryCandidatesSchema,
  emptyPreflightIndex,
  resolveDiscoveryPreflightResults,
  type DiscoveryPreflightCandidate,
  type DiscoveryPreflightIndex,
  type PreflightPostingRow,
} from "@/lib/discovery/preflight";
import { registerJobTools } from "@/lib/mcp/tools";

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

function candidate(
  overrides: Partial<DiscoveryPreflightCandidate> &
    Pick<DiscoveryPreflightCandidate, "client_candidate_id" | "company" | "title" | "url" | "source">,
): DiscoveryPreflightCandidate {
  return {
    external_job_id: "",
    location: "",
    posted_date: "",
    description_hash: "",
    ...overrides,
  };
}

function posting(
  row: Partial<PreflightPostingRow> & Pick<PreflightPostingRow, "id" | "canonical_job_id">,
): PreflightPostingRow {
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

function validEvaluation(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    client_evaluation_id: randomUUID(),
    client_candidate_id: "c1",
    company: "Acme",
    title: "Staff AI Engineer",
    url: "https://example.com/jobs/staff-ai",
    source: "greenhouse",
    external_job_id: "REQ-1",
    location: "United States",
    description_hash: HASH_A,
    gpt_relevance_score: 70,
    gpt_decision: "QUALIFIED",
    reasoning_summary: "Strong AI platform ownership.",
    evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
    ...overrides,
  };
}

const VALID_JOB = {
  company: "AgentForge",
  title: "Staff AI Engineer, Agent Platform",
  url: "https://example.com/jobs/staff-ai",
  location: "United States",
  source: "Greenhouse",
  description: "Build production LLM agents.",
  required_skills: ["Python"],
  preferred_skills: [] as string[],
  remote_status: "Remote" as const,
  salary: "$220k",
  posted_date: "2026-08-16",
};

describe("GPT relevance admission schemas", () => {
  it("accepts score 70 as QUALIFIED", () => {
    const parsed = discoveryGptEvaluationRecordSchema.parse(
      validEvaluation({ gpt_relevance_score: 70 }),
    );
    expect(parsed.gpt_decision).toBe("QUALIFIED");
  });

  it("rejects QUALIFIED below threshold and REJECTED_LOW_SCORE at/above threshold", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({ gpt_relevance_score: 69, gpt_decision: "QUALIFIED" }),
      ),
    ).toThrow();
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({ gpt_relevance_score: 70, gpt_decision: "REJECTED_LOW_SCORE" }),
      ),
    ).toThrow();
  });

  it("rejects score outside 0-100", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(validEvaluation({ gpt_relevance_score: 101 })),
    ).toThrow();
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(validEvaluation({ gpt_relevance_score: -1 })),
    ).toThrow();
  });

  it("requires hard_rejection_reason only for REJECTED_HARD_RULE", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
        }),
      ),
    ).toThrow();
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({
          gpt_decision: "QUALIFIED",
          hard_rejection_reason: "should not be set",
        }),
      ),
    ).toThrow();
    expect(
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
          hard_rejection_reason: "internship or junior role",
        }),
      ).hard_rejection_reason,
    ).toBe("internship or junior role");
  });

  it("rejects invalid description_hash format", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(validEvaluation({ description_hash: "hash-a" })),
    ).toThrow();
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({ description_hash: "ABCDEF0123456789" }),
      ),
    ).toThrow();
  });

  it("accepts canonical 16-char lowercase hex description_hash", () => {
    const parsed = discoveryGptEvaluationRecordSchema.parse(
      validEvaluation({ description_hash: "3406d8a6ef8edfbe" }),
    );
    expect(parsed.description_hash).toBe("3406d8a6ef8edfbe");
  });

  it("requires client_evaluation_id UUID and batch size 1-100", () => {
    expect(() =>
      discoveryGptEvaluationRecordSchema.parse(
        validEvaluation({ client_evaluation_id: "not-a-uuid" }),
      ),
    ).toThrow();
    expect(() => recordDiscoveryEvaluationsSchema.parse({ evaluations: [] })).toThrow();
    expect(() =>
      recordDiscoveryEvaluationsSchema.parse({
        evaluations: Array.from({ length: 101 }, () => validEvaluation()),
      }),
    ).toThrow();
  });
});

describe("submit_discovery_batch GPT attachment schema", () => {
  it("rejects rejected decisions from inbox attachment schema", () => {
    expect(() =>
      discoveryJobSchema.parse({
        ...VALID_JOB,
        gpt_evaluation: {
          evaluation_id: randomUUID(),
          gpt_relevance_score: 40,
          gpt_decision: "REJECTED_LOW_SCORE",
        },
      }),
    ).toThrow();
  });

  it("rejects top-level GPT score fields on jobs", () => {
    expect(() =>
      discoveryJobSchema.parse({
        ...VALID_JOB,
        gpt_relevance_score: 90,
      }),
    ).toThrow();
  });

  it("remains backward-compatible without gpt_evaluation when flag is off", () => {
    expect(submitDiscoveryBatchSchema.parse({ jobs: [VALID_JOB], source: "chatgpt" }).jobs).toHaveLength(
      1,
    );
  });
});

describe("record_discovery_evaluations persistence coverage", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
  });

  it("persists hard rejection without creating inbox or canonical jobs", async () => {
    const result = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          gpt_decision: "REJECTED_HARD_RULE",
          gpt_relevance_score: 0,
          hard_rejection_reason: "internship or junior role",
        }),
      ] as never,
    });
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].gpt_decision).toBe("REJECTED_HARD_RULE");
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
    expect(result.evaluations[0]).not.toHaveProperty("canonical_job_id");
  });

  it("keeps GPT admission scores separate from Python profile-v1 fields", async () => {
    const result = await recordDiscoveryEvaluations({
      evaluations: [validEvaluation({ gpt_relevance_score: 82 })] as never,
    });
    const row = result.evaluations[0];
    expect(row.gpt_relevance_score).toBe(82);
    expect(row).not.toHaveProperty("match_score");
    expect(row).not.toHaveProperty("scoring_version");
    expect(row).not.toHaveProperty("profile_version");
  });

  it("retains evaluation history by version and description hash", async () => {
    await recordDiscoveryEvaluations({
      evaluations: [validEvaluation({ description_hash: HASH_A, gpt_relevance_score: 71 })] as never,
    });
    await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          description_hash: HASH_B,
          gpt_relevance_score: 75,
        }),
      ] as never,
    });
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(2);
  });
});

describe("server-authoritative evaluation ordering", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
  });

  it("future evaluated_at cannot shadow a later server record", async () => {
    const url = "https://example.com/jobs/ordering";
    const first = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          url,
          evaluated_at: "2099-01-01T00:00:00.000Z",
          gpt_relevance_score: 40,
          gpt_decision: "REJECTED_LOW_SCORE",
          reasoning_summary: "old future-dated client stamp",
        }),
      ] as never,
    });
    const firstId = String(first.evaluations[0].evaluation_id);
    setMemoryEvaluationCreatedAt(firstId, "2020-01-01T00:00:00.000Z");

    const second = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          url,
          evaluated_at: "2010-01-01T00:00:00.000Z",
          gpt_relevance_score: 88,
          gpt_decision: "QUALIFIED",
          reasoning_summary: "newer server record",
        }),
      ] as never,
    });
    const secondId = String(second.evaluations[0].evaluation_id);

    const latest = await loadLatestGptEvaluationsForPreflight({
      normalizedUrls: [normalizeJobUrl(url)!],
      sourceExternalKeys: [],
      sources: [],
      externalJobIds: [],
    });
    const row = latest.byNormalizedUrl.get(normalizeJobUrl(url)!);
    expect(row?.evaluation_id).toBe(secondId);
    expect(row?.gpt_relevance_score).toBe(88);
    expect(row?.evaluation_id).not.toBe(firstId);
  });
});

describe("idempotent evaluation recording", () => {
  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
  });

  it("identical retry returns the existing record", async () => {
    const payload = validEvaluation();
    const first = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    const second = await recordDiscoveryEvaluations({ evaluations: [payload] as never });
    expect(second.evaluations[0].evaluation_id).toBe(first.evaluations[0].evaluation_id);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });

  it("conflicting retry with same client_evaluation_id is rejected", async () => {
    const id = randomUUID();
    await recordDiscoveryEvaluations({
      evaluations: [validEvaluation({ client_evaluation_id: id, gpt_relevance_score: 70 })] as never,
    });
    await expect(
      recordDiscoveryEvaluations({
        evaluations: [
          validEvaluation({
            client_evaluation_id: id,
            gpt_relevance_score: 90,
            reasoning_summary: "different payload",
          }),
        ] as never,
      }),
    ).rejects.toThrow(/different evaluation payload/i);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });

  it("returns evaluation_id and client_evaluation_id in input order", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const result = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({ client_evaluation_id: a, client_candidate_id: "first" }),
        validEvaluation({ client_evaluation_id: b, client_candidate_id: "second" }),
      ] as never,
    });
    expect(result.evaluations.map((row) => row.client_evaluation_id)).toEqual([a, b]);
    expect(result.evaluations[0].evaluation_id).toBeTruthy();
    expect(result.evaluations[1].evaluation_id).toBeTruthy();
  });

  it("concurrent evaluation retry creates one record", async () => {
    const payload = validEvaluation();
    setMemoryGptEvaluationInsertDelayMs(25);
    const results = await Promise.all([
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
      recordDiscoveryEvaluations({ evaluations: [payload] as never }),
    ]);
    const ids = new Set(results.map((r) => String(r.evaluations[0].evaluation_id)));
    expect(ids.size).toBe(1);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });
});

describe("production admission gate", () => {
  const previous = process.env.DISCOVERY_REQUIRE_GPT_EVALUATION;

  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.DISCOVERY_REQUIRE_GPT_EVALUATION;
    else process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = previous;
  });

  it("rejects missing evaluation when flag is enabled", async () => {
    await expect(assertDiscoveryJobsGptAdmissionGate([VALID_JOB])).rejects.toThrow(
      /requires gpt_evaluation/i,
    );
  });

  it("rejects mismatched identity", async () => {
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [validEvaluation({ url: "https://example.com/jobs/other" })] as never,
    });
    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 70,
            gpt_decision: "QUALIFIED",
            evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
          },
        },
      ]),
    ).rejects.toThrow(/identity does not match/i);
  });

  it("rejects score 69 / non-qualified stored evidence under production gate", async () => {
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          url: VALID_JOB.url,
          gpt_relevance_score: 69,
          gpt_decision: "REJECTED_LOW_SCORE",
          reasoning_summary: "below threshold",
        }),
      ] as never,
    });
    expect(() =>
      discoveryJobSchema.parse({
        ...VALID_JOB,
        gpt_evaluation: {
          evaluation_id: String(recorded.evaluations[0].evaluation_id),
          gpt_relevance_score: 69,
          gpt_decision: "QUALIFIED",
        },
      }),
    ).toThrow();

    await expect(
      assertDiscoveryJobsGptAdmissionGate([
        {
          ...VALID_JOB,
          gpt_evaluation: {
            evaluation_id: String(recorded.evaluations[0].evaluation_id),
            gpt_relevance_score: 70,
            gpt_decision: "QUALIFIED",
            evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
          },
        },
      ]),
    ).rejects.toThrow(/non-QUALIFIED|score below/i);
  });
  it("accepts stored qualified score 70", async () => {
    const recorded = await recordDiscoveryEvaluations({
      evaluations: [
        validEvaluation({
          url: VALID_JOB.url,
          gpt_relevance_score: 70,
          gpt_decision: "QUALIFIED",
        }),
      ] as never,
    });
    const job = discoveryJobSchema.parse({
      ...VALID_JOB,
      gpt_evaluation: {
        evaluation_id: String(recorded.evaluations[0].evaluation_id),
        gpt_relevance_score: 70,
        gpt_decision: "QUALIFIED",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        reasoning_summary: "Strong AI platform ownership.",
      },
    });
    await expect(assertDiscoveryJobsGptAdmissionGate([job])).resolves.toBeUndefined();
  });

  it("defaults to optional evaluation when flag is false", () => {
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "false";
    expect(submitDiscoveryBatchSchema.parse({ jobs: [VALID_JOB], source: "chatgpt" }).jobs).toHaveLength(
      1,
    );
  });

  it("parses DISCOVERY_REQUIRE_GPT_EVALUATION only for documented true", async () => {
    const { isDiscoveryGptEvaluationRequired } = await import("@/lib/discovery/gpt_evaluation");

    delete process.env.DISCOVERY_REQUIRE_GPT_EVALUATION;
    expect(isDiscoveryGptEvaluationRequired()).toBe(false);

    for (const value of ["false", "0", "yes", "1", "on", ""]) {
      process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = value;
      expect(isDiscoveryGptEvaluationRequired()).toBe(false);
    }

    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "true";
    expect(isDiscoveryGptEvaluationRequired()).toBe(true);
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = "TRUE";
    expect(isDiscoveryGptEvaluationRequired()).toBe(true);
    process.env.DISCOVERY_REQUIRE_GPT_EVALUATION = " true ";
    expect(isDiscoveryGptEvaluationRequired()).toBe(true);
  });
});

describe("prior qualified / rejected reuse and skip", () => {
  it("allows skipping unchanged rejected candidates", () => {
    const fields = resolveGptPreflightFields({
      matchedBy: "normalized_url",
      candidateDescriptionHash: HASH_A,
      priorGpt: {
        evaluation_id: randomUUID(),
        gpt_relevance_score: 40,
        gpt_decision: "REJECTED_LOW_SCORE",
        hard_rejection_reason: null,
        reasoning_summary: "weak fit",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      requestedEvaluationVersion: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(fields.gpt_reevaluation_required).toBe(false);
    expect(fields.gpt_skip_allowed).toBe(true);
    expect(fields.gpt_reuse_allowed).toBe(false);
  });

  it("allows reusing prior qualified evaluation without rescoring", () => {
    const evaluationId = randomUUID();
    const fields = resolveGptPreflightFields({
      matchedBy: "normalized_url",
      candidateDescriptionHash: HASH_A,
      priorGpt: {
        evaluation_id: evaluationId,
        gpt_relevance_score: 82,
        gpt_decision: "QUALIFIED",
        hard_rejection_reason: null,
        reasoning_summary: "strong",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      requestedEvaluationVersion: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(fields.gpt_reevaluation_required).toBe(false);
    expect(fields.gpt_skip_allowed).toBe(false);
    expect(fields.gpt_reuse_allowed).toBe(true);
    expect(fields.prior_gpt_evaluation?.evaluation_id).toBe(evaluationId);
  });

  it("requires reevaluation when description hash changes", () => {
    const fields = resolveGptPreflightFields({
      matchedBy: "normalized_url",
      candidateDescriptionHash: HASH_B,
      priorGpt: {
        evaluation_id: randomUUID(),
        gpt_relevance_score: 40,
        gpt_decision: "REJECTED_LOW_SCORE",
        hard_rejection_reason: null,
        reasoning_summary: "weak",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      requestedEvaluationVersion: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(fields.gpt_reevaluation_required).toBe(true);
    expect(fields.gpt_skip_allowed).toBe(false);
    expect(fields.gpt_reuse_allowed).toBe(false);
  });

  it("requires reevaluation when rubric version changes", () => {
    const fields = resolveGptPreflightFields({
      matchedBy: "source_external_id",
      candidateDescriptionHash: HASH_A,
      priorGpt: {
        evaluation_id: randomUUID(),
        gpt_relevance_score: 40,
        gpt_decision: "REJECTED_HARD_RULE",
        hard_rejection_reason: "non-US role",
        reasoning_summary: "excluded",
        evaluation_version: "gpt-fit-v0",
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      requestedEvaluationVersion: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(fields.gpt_reevaluation_required).toBe(true);
    expect(fields.gpt_skip_allowed).toBe(false);
    expect(fields.gpt_reuse_allowed).toBe(false);
  });

  it("requires reevaluation when candidate description hash is empty", () => {
    const fields = resolveGptPreflightFields({
      matchedBy: "normalized_url",
      candidateDescriptionHash: "",
      priorGpt: {
        evaluation_id: randomUUID(),
        gpt_relevance_score: 40,
        gpt_decision: "REJECTED_LOW_SCORE",
        hard_rejection_reason: null,
        reasoning_summary: "weak",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      requestedEvaluationVersion: DEFAULT_GPT_EVALUATION_VERSION,
    });
    expect(fields.gpt_reevaluation_required).toBe(true);
    expect(fields.gpt_skip_allowed).toBe(false);
    expect(fields.gpt_reuse_allowed).toBe(false);
  });

  it("returns prior GPT evaluation only on deterministic identity", () => {
    const url = "https://example.com/jobs/1";
    const normalized = normalizeJobUrl(url)!;
    const evaluationId = randomUUID();
    const existing = posting({
      id: "post-1",
      canonical_job_id: "canon-1",
      source: "ashby",
      url,
      normalized_url: normalized,
      description_hash: HASH_A,
    });
    const index = indexWith((idx) => {
      idx.postingsByNormalizedUrl.set(normalized, existing);
      idx.gptByNormalizedUrl.set(normalized, {
        evaluation_id: evaluationId,
        gpt_relevance_score: 82,
        gpt_decision: "QUALIFIED",
        hard_rejection_reason: null,
        reasoning_summary: "strong",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
        normalized_url: normalized,
        source: "ashby",
        external_job_id: null,
      });
    });

    const [deterministic] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c1",
          company: "Acme",
          title: "Staff Engineer",
          url,
          source: "linkedin",
          description_hash: HASH_A,
        }),
      ],
      index,
    );
    expect(deterministic.gpt_reuse_allowed).toBe(true);
    expect(deterministic.prior_gpt_evaluation?.evaluation_id).toBe(evaluationId);

    const companyKey = "acme";
    const titleKey = "staff engineer";
    const softIndex = indexWith((idx) => {
      idx.canonicalsByCompanyTitle.set(`${companyKey}\0${titleKey}`, [
        {
          id: "canon-soft",
          company_key: companyKey,
          normalized_title: titleKey,
          location: "Remote US",
          normalized_location: "remote us",
        },
      ]);
      idx.postingsByCanonicalId.set("canon-soft", [
        posting({
          id: "post-soft",
          canonical_job_id: "canon-soft",
          source: "lever",
          description_hash: HASH_A,
          location: "Remote US",
        }),
      ]);
      idx.gptByNormalizedUrl.set(normalized, {
        evaluation_id: evaluationId,
        gpt_relevance_score: 35,
        gpt_decision: "REJECTED_LOW_SCORE",
        hard_rejection_reason: null,
        reasoning_summary: "low",
        evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
        description_hash: HASH_A,
        evaluated_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
        normalized_url: normalized,
        source: "ashby",
        external_job_id: null,
      });
    });

    const [soft] = resolveDiscoveryPreflightResults(
      [
        candidate({
          client_candidate_id: "c2",
          company: "Acme",
          title: "Staff Engineer",
          url: "https://other.example.com/jobs/soft",
          source: "linkedin",
          description_hash: HASH_A,
          location: "Remote US",
        }),
      ],
      softIndex,
    );
    expect(soft.matched_by).toBe("canonical_signals");
    expect(soft.prior_gpt_evaluation).toBeNull();
    expect(soft.gpt_reevaluation_required).toBe(true);
    expect(soft.gpt_reuse_allowed).toBe(false);
  });
});

describe("preflight forbidden GPT fields", () => {
  it("rejects score/decision/reasoning inside candidate objects", () => {
    for (const bad of [
      { gpt_relevance_score: 80 },
      { gpt_decision: "QUALIFIED" },
      { reasoning_summary: "x" },
    ]) {
      const parsed = checkDiscoveryCandidatesSchema.safeParse({
        candidates: [
          {
            ...candidate({
              client_candidate_id: "bad",
              company: "Acme",
              title: "Engineer",
              url: "https://example.com/bad",
              source: "ashby",
            }),
            ...bad,
          },
        ],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts optional top-level evaluation_version", () => {
    const parsed = checkDiscoveryCandidatesSchema.parse({
      evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
      candidates: [
        candidate({
          client_candidate_id: "ok",
          company: "Acme",
          title: "Engineer",
          url: "https://example.com/ok",
          source: "ashby",
        }),
      ],
    });
    expect(parsed.evaluation_version).toBe(DEFAULT_GPT_EVALUATION_VERSION);
  });
});

describe("record_discovery_evaluations MCP registration", () => {
  function makeExtra(scopes: string[]) {
    return {
      http: {
        authInfo: { token: "t", clientId: "c", scopes },
      },
    };
  }

  function register() {
    const tools: Record<
      string,
      {
        config: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: ReturnType<typeof makeExtra>,
        ) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>;
      }
    > = {};
    const server = {
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (typeof tools)[string]["handler"],
      ) {
        tools[name] = { config, handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);
    return tools;
  }

  function parse(result: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }) {
    if (result.isError) return { isError: true, text: result.content[0]?.text };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  beforeEach(() => {
    useInMemoryDiscoveryGptEvaluations();
    resetInMemoryDiscoveryGptEvaluations();
  });

  it("registers tool with jobs:write and idempotent hint", () => {
    const tools = register();
    expect(tools.record_discovery_evaluations).toBeTruthy();
    expect(TOOL_PERMISSIONS.record_discovery_evaluations).toBe("jobs:write");
    expect(tools.record_discovery_evaluations.config.annotations).toMatchObject({
      idempotentHint: true,
    });
    expect(String(tools.record_discovery_evaluations.config.description)).toMatch(
      /does not create canonical jobs/i,
    );
  });

  it("requires jobs:write permission", async () => {
    const tools = register();
    const denied = parse(
      await tools.record_discovery_evaluations.handler(
        { evaluations: [validEvaluation()] },
        makeExtra(["jobs:read"]),
      ),
    );
    expect(denied.isError).toBe(true);
  });

  it("records evaluations with write scope", async () => {
    const tools = register();
    const result = parse(
      await tools.record_discovery_evaluations.handler(
        { evaluations: [validEvaluation()] },
        makeExtra(["jobs:write"]),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(getMemoryDiscoveryGptEvaluations()).toHaveLength(1);
  });
});
