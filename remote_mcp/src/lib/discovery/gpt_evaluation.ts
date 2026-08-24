/**
 * GPT discovery admission evaluation (gpt-fit-v1).
 * GPT scores semantic relevance; MCP stores evidence only.
 * Separate from Python profile-v1 job_evaluations.
 */

import { z } from "zod";

import { normalizeJobUrl } from "./normalize";

export const DEFAULT_GPT_EVALUATION_VERSION = "gpt-fit-v1";
export const GPT_QUALIFIED_THRESHOLD = 70;
export const GPT_REASONING_MAX_LEN = 1000;

/** Canonical description fingerprint: sha256(normalized)[:16] hex. Empty = unavailable. */
export const DESCRIPTION_HASH_PATTERN = /^([a-f0-9]{16})?$/;

export const GPT_DECISIONS = [
  "QUALIFIED",
  "REJECTED_LOW_SCORE",
  "REJECTED_HARD_RULE",
] as const;

export type GptDecision = (typeof GPT_DECISIONS)[number];

export type DeterministicMatchBy = "normalized_url" | "source_external_id";

export type PriorGptEvaluationSummary = {
  evaluation_id: string;
  gpt_relevance_score: number;
  gpt_decision: GptDecision;
  hard_rejection_reason: string | null;
  reasoning_summary: string | null;
  evaluation_version: string;
  description_hash: string | null;
  evaluated_at: string | null;
  created_at: string;
};

export type GptPreflightFields = {
  prior_gpt_evaluation: PriorGptEvaluationSummary | null;
  gpt_reevaluation_required: boolean;
  gpt_skip_allowed: boolean;
  gpt_reuse_allowed: boolean;
};

const identityText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "must be a non-empty string");

const optionalIdentityText = (max: number) => z.string().max(max).default("");

export const descriptionHashSchema = z
  .string()
  .max(16)
  .regex(DESCRIPTION_HASH_PATTERN, "description_hash must be empty or 16 lowercase hex chars");

export const discoveryGptEvaluationRecordSchema = z
  .object({
    client_evaluation_id: z.string().uuid(),
    client_candidate_id: identityText(128),
    company: identityText(512),
    title: identityText(512),
    url: identityText(2048),
    source: identityText(128),
    external_job_id: optionalIdentityText(256),
    location: optionalIdentityText(512),
    description_hash: descriptionHashSchema.default(""),
    gpt_relevance_score: z.number().int().min(0).max(100),
    gpt_decision: z.enum(GPT_DECISIONS),
    hard_rejection_reason: z.string().max(500).nullable().optional(),
    reasoning_summary: z.string().max(GPT_REASONING_MAX_LEN),
    evaluation_version: z.string().min(1).max(64).default(DEFAULT_GPT_EVALUATION_VERSION),
    /** Client evidence only — never used for latest ordering. */
    evaluated_at: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const reason = record.hard_rejection_reason?.trim() || "";
    if (record.gpt_decision === "REJECTED_HARD_RULE") {
      if (!reason) {
        ctx.addIssue({
          code: "custom",
          message: "hard_rejection_reason is required when gpt_decision is REJECTED_HARD_RULE",
        });
      }
    } else if (record.hard_rejection_reason != null && reason) {
      ctx.addIssue({
        code: "custom",
        message: "hard_rejection_reason must be absent unless gpt_decision is REJECTED_HARD_RULE",
      });
    }
    if (record.gpt_decision === "QUALIFIED" && record.gpt_relevance_score < GPT_QUALIFIED_THRESHOLD) {
      ctx.addIssue({
        code: "custom",
        message: `QUALIFIED decisions require gpt_relevance_score >= ${GPT_QUALIFIED_THRESHOLD}`,
      });
    }
    if (
      record.gpt_decision === "REJECTED_LOW_SCORE" &&
      record.gpt_relevance_score >= GPT_QUALIFIED_THRESHOLD
    ) {
      ctx.addIssue({
        code: "custom",
        message: `REJECTED_LOW_SCORE requires gpt_relevance_score < ${GPT_QUALIFIED_THRESHOLD}`,
      });
    }
  });

export const recordDiscoveryEvaluationsSchema = z
  .object({
    evaluations: z.array(discoveryGptEvaluationRecordSchema).min(1).max(100),
  })
  .strict();

export type DiscoveryGptEvaluationInput = z.infer<typeof discoveryGptEvaluationRecordSchema>;

export const gptAdmissionAttachmentSchema = z
  .object({
    evaluation_id: z.string().uuid(),
    gpt_relevance_score: z.number().int().min(GPT_QUALIFIED_THRESHOLD).max(100),
    gpt_decision: z.literal("QUALIFIED"),
    evaluation_version: z.string().min(1).max(64).default(DEFAULT_GPT_EVALUATION_VERSION),
    reasoning_summary: z.string().max(GPT_REASONING_MAX_LEN).optional(),
    description_hash: descriptionHashSchema.optional(),
  })
  .strict();

export function sourceExternalLookupKey(source: string, externalJobId: string): string {
  return `${source}\0${externalJobId}`;
}

export function isDeterministicPreflightMatch(
  matchedBy: string,
): matchedBy is DeterministicMatchBy {
  return matchedBy === "normalized_url" || matchedBy === "source_external_id";
}

export function toPriorGptSummary(
  prior: PriorGptEvaluationSummary,
): PriorGptEvaluationSummary {
  return {
    evaluation_id: prior.evaluation_id,
    gpt_relevance_score: prior.gpt_relevance_score,
    gpt_decision: prior.gpt_decision,
    hard_rejection_reason: prior.hard_rejection_reason,
    reasoning_summary: prior.reasoning_summary,
    evaluation_version: prior.evaluation_version,
    description_hash: prior.description_hash,
    evaluated_at: prior.evaluated_at,
    created_at: prior.created_at,
  };
}

export function resolveGptPreflightFields(params: {
  matchedBy: string;
  candidateDescriptionHash: string;
  priorGpt: PriorGptEvaluationSummary | null;
  requestedEvaluationVersion: string;
}): GptPreflightFields {
  const { matchedBy, candidateDescriptionHash, priorGpt, requestedEvaluationVersion } = params;
  const candidateHash = candidateDescriptionHash.trim();

  const blocked: GptPreflightFields = {
    prior_gpt_evaluation: null,
    gpt_reevaluation_required: true,
    gpt_skip_allowed: false,
    gpt_reuse_allowed: false,
  };

  if (!isDeterministicPreflightMatch(matchedBy)) {
    return blocked;
  }

  if (!priorGpt) {
    return blocked;
  }

  const summary = toPriorGptSummary(priorGpt);
  const priorVersion = summary.evaluation_version.trim();
  const priorHash = (summary.description_hash || "").trim();

  if (priorVersion !== requestedEvaluationVersion) {
    return {
      prior_gpt_evaluation: summary,
      gpt_reevaluation_required: true,
      gpt_skip_allowed: false,
      gpt_reuse_allowed: false,
    };
  }

  if (!candidateHash || !priorHash || candidateHash !== priorHash) {
    return {
      prior_gpt_evaluation: summary,
      gpt_reevaluation_required: true,
      gpt_skip_allowed: false,
      gpt_reuse_allowed: false,
    };
  }

  const isRejected =
    summary.gpt_decision === "REJECTED_LOW_SCORE" ||
    summary.gpt_decision === "REJECTED_HARD_RULE";
  const isQualified = summary.gpt_decision === "QUALIFIED";

  return {
    prior_gpt_evaluation: summary,
    gpt_reevaluation_required: false,
    gpt_skip_allowed: isRejected,
    gpt_reuse_allowed: isQualified,
  };
}

/** Canonical payload fields used for idempotent conflict detection. */
export function gptEvaluationIdempotencyFingerprint(
  record: DiscoveryGptEvaluationInput & { normalized_url: string | null },
): string {
  return JSON.stringify({
    client_candidate_id: record.client_candidate_id.trim(),
    company: record.company.trim(),
    title: record.title.trim(),
    url: record.url.trim(),
    normalized_url: record.normalized_url,
    source: record.source.trim(),
    external_job_id: (record.external_job_id || "").trim(),
    location: (record.location || "").trim(),
    description_hash: (record.description_hash || "").trim(),
    gpt_relevance_score: record.gpt_relevance_score,
    gpt_decision: record.gpt_decision,
    hard_rejection_reason:
      record.gpt_decision === "REJECTED_HARD_RULE"
        ? (record.hard_rejection_reason?.trim() || null)
        : null,
    reasoning_summary: record.reasoning_summary,
    evaluation_version: record.evaluation_version,
  });
}

export function normalizeGptEvaluationRecord(
  record: DiscoveryGptEvaluationInput,
): DiscoveryGptEvaluationInput & { normalized_url: string | null } {
  const normalized_url = normalizeJobUrl(record.url);
  const hardReason =
    record.gpt_decision === "REJECTED_HARD_RULE"
      ? record.hard_rejection_reason?.trim() || null
      : null;
  return {
    ...record,
    external_job_id: record.external_job_id ?? "",
    location: record.location ?? "",
    description_hash: record.description_hash ?? "",
    hard_rejection_reason: hardReason,
    evaluation_version: record.evaluation_version || DEFAULT_GPT_EVALUATION_VERSION,
    normalized_url,
  };
}

export function isDiscoveryGptEvaluationRequired(): boolean {
  // Enable only for the documented value "true" (case-insensitive).
  // Absent, false, 0, yes, 1, and other values stay disabled.
  const raw = process.env.DISCOVERY_REQUIRE_GPT_EVALUATION?.trim().toLowerCase();
  return raw === "true";
}
