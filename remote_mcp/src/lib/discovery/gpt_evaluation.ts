/**
 * GPT discovery admission evaluation (gpt-fit-v1 / gpt-fit-v2).
 * GPT scores semantic relevance; MCP stores evidence only.
 * Separate from Python profile-v1 job_evaluations.
 */

import { z } from "zod";

import {
  DESCRIPTION_NORMALIZATION_VERSION,
  isCanonicalDescriptionHash,
} from "./description_hash";
import { normalizeJobUrl } from "./normalize";
import {
  classifyPostingUrl,
  isDeterministicallyInvalidPostingUrl,
  isMalformedJobUrl,
} from "./posting_url";

export const DEFAULT_GPT_EVALUATION_VERSION = "gpt-fit-v1";
export const GPT_FIT_V2 = "gpt-fit-v2";
export const GPT_QUALIFIED_THRESHOLD = 70;
export const GPT_REASONING_MAX_LEN = 1000;

/** Canonical description fingerprint: sha256(normalized)[:16] hex. Empty = unavailable. */
export const DESCRIPTION_HASH_PATTERN = /^([a-f0-9]{16})?$/;
export { DESCRIPTION_NORMALIZATION_VERSION };

export const GPT_DECISIONS = [
  "QUALIFIED",
  "REJECTED_LOW_SCORE",
  "REJECTED_HARD_RULE",
] as const;

export type GptDecision = (typeof GPT_DECISIONS)[number];

export const REMOTE_SCOPES = [
  "US_NATIONWIDE",
  "US_RESTRICTED",
  "HYBRID",
  "ONSITE",
  "NON_US",
  "UNKNOWN",
] as const;

export type RemoteScope = (typeof REMOTE_SCOPES)[number];

export const POSTING_STATUSES = ["OPEN", "CLOSED", "UNKNOWN"] as const;

export type PostingStatus = (typeof POSTING_STATUSES)[number];

export type DeterministicMatchBy = "normalized_url" | "source_external_id";

export type PriorGptEvaluationSummary = {
  evaluation_id: string;
  gpt_relevance_score: number;
  gpt_decision: GptDecision;
  hard_rejection_reason: string | null;
  reasoning_summary: string | null;
  evaluation_version: string;
  description_hash: string | null;
  remote_scope?: RemoteScope | null;
  direct_posting_url_verified?: boolean | null;
  normalization_version?: string | null;
  posting_status?: PostingStatus | null;
  posting_status_verified_at?: string | null;
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

export function isGptFitV2(version: string | null | undefined): boolean {
  return (version || "").trim() === GPT_FIT_V2;
}

export function remoteScopeHardRejectionReason(scope: RemoteScope): string {
  switch (scope) {
    case "US_RESTRICTED":
      return "remote role restricted to a specific city, state, or region";
    case "HYBRID":
      return "hybrid role; gpt-fit-v2 requires fully remote US nationwide";
    case "ONSITE":
      return "onsite role; gpt-fit-v2 requires fully remote US nationwide";
    case "NON_US":
      return "non-US role";
    case "UNKNOWN":
      return "remote scope unknown; gpt-fit-v2 requires US_NATIONWIDE";
    case "US_NATIONWIDE":
      return "US nationwide remote";
    default:
      return "remote scope not eligible under gpt-fit-v2";
  }
}

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
    remote_scope: z.enum(REMOTE_SCOPES).nullable().optional(),
    direct_posting_url_verified: z.boolean().nullable().optional(),
    normalization_version: z.string().min(1).max(64).nullable().optional(),
    posting_status: z.enum(POSTING_STATUSES).nullable().optional(),
    posting_status_verified_at: z.string().datetime().nullable().optional(),
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

    const version = record.evaluation_version || DEFAULT_GPT_EVALUATION_VERSION;
    if (!isGptFitV2(version)) {
      return;
    }

    // gpt-fit-v2 structured evidence required.
    if (record.remote_scope == null) {
      ctx.addIssue({
        code: "custom",
        message: "remote_scope is required for gpt-fit-v2 evaluations",
      });
    }
    if (record.direct_posting_url_verified == null) {
      ctx.addIssue({
        code: "custom",
        message: "direct_posting_url_verified is required for gpt-fit-v2 evaluations",
      });
    }
    if (record.posting_status == null) {
      ctx.addIssue({
        code: "custom",
        message: "posting_status is required for gpt-fit-v2 evaluations",
      });
    }

    if (record.remote_scope && record.remote_scope !== "US_NATIONWIDE") {
      if (record.gpt_decision === "QUALIFIED") {
        ctx.addIssue({
          code: "custom",
          message: `gpt-fit-v2 QUALIFIED requires remote_scope=US_NATIONWIDE (got ${record.remote_scope})`,
        });
      } else if (record.gpt_decision !== "REJECTED_HARD_RULE") {
        ctx.addIssue({
          code: "custom",
          message: `gpt-fit-v2 non-US_NATIONWIDE remote_scope must use REJECTED_HARD_RULE (got ${record.gpt_decision})`,
        });
      }
    }

    if (record.posting_status && record.posting_status !== "OPEN") {
      if (record.gpt_decision === "QUALIFIED") {
        ctx.addIssue({
          code: "custom",
          message: `gpt-fit-v2 QUALIFIED requires posting_status=OPEN (got ${record.posting_status})`,
        });
      } else if (record.gpt_decision !== "REJECTED_HARD_RULE") {
        ctx.addIssue({
          code: "custom",
          message: `gpt-fit-v2 non-OPEN posting_status must use REJECTED_HARD_RULE (got ${record.gpt_decision})`,
        });
      }
    }

    if (record.gpt_decision === "QUALIFIED") {
      if (record.direct_posting_url_verified !== true) {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires direct_posting_url_verified=true",
        });
      }
      if (!isCanonicalDescriptionHash(record.description_hash)) {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires non-empty canonical description_hash",
        });
      }
      if (!record.normalization_version?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires normalization_version",
        });
      }
      if (record.posting_status !== "OPEN") {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires posting_status=OPEN",
        });
      }
      if (!record.posting_status_verified_at) {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires posting_status_verified_at",
        });
      }
      if (isMalformedJobUrl(record.url)) {
        ctx.addIssue({
          code: "custom",
          message: "gpt-fit-v2 QUALIFIED requires a parseable http(s) posting URL",
        });
      }
      if (isDeterministicallyInvalidPostingUrl(record.url)) {
        const classification = classifyPostingUrl(record.url);
        ctx.addIssue({
          code: "custom",
          message: `gpt-fit-v2 QUALIFIED rejected: URL classified as ${classification.url_class} (${classification.reason})`,
        });
      }
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
    remote_scope: z.enum(REMOTE_SCOPES).optional(),
    direct_posting_url_verified: z.boolean().optional(),
    normalization_version: z.string().min(1).max(64).optional(),
    posting_status: z.enum(POSTING_STATUSES).optional(),
    posting_status_verified_at: z.string().datetime().optional(),
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
    remote_scope: prior.remote_scope ?? null,
    direct_posting_url_verified: prior.direct_posting_url_verified ?? null,
    normalization_version: prior.normalization_version ?? null,
    posting_status: prior.posting_status ?? null,
    posting_status_verified_at: prior.posting_status_verified_at ?? null,
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
  const requested = requestedEvaluationVersion.trim();

  // Never reuse gpt-fit-v1 evidence when gpt-fit-v2 is requested (and vice versa on mismatch).
  if (priorVersion !== requested) {
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
    remote_scope: record.remote_scope ?? null,
    direct_posting_url_verified: record.direct_posting_url_verified ?? null,
    normalization_version: record.normalization_version ?? null,
    posting_status: record.posting_status ?? null,
    posting_status_verified_at: record.posting_status_verified_at ?? null,
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
  const version = record.evaluation_version || DEFAULT_GPT_EVALUATION_VERSION;
  return {
    ...record,
    external_job_id: record.external_job_id ?? "",
    location: record.location ?? "",
    description_hash: record.description_hash ?? "",
    hard_rejection_reason: hardReason,
    evaluation_version: version,
    remote_scope: record.remote_scope ?? null,
    direct_posting_url_verified: record.direct_posting_url_verified ?? null,
    normalization_version: record.normalization_version ?? null,
    posting_status: record.posting_status ?? null,
    posting_status_verified_at: record.posting_status_verified_at ?? null,
    normalized_url,
  };
}

function envFlagTrue(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "true";
}

export function isDiscoveryGptEvaluationRequired(): boolean {
  return envFlagTrue("DISCOVERY_REQUIRE_GPT_EVALUATION");
}

/** Empty / unset preserves backward compatibility (no version pin). */
export function getRequiredDiscoveryEvaluationVersion(): string | null {
  const raw = process.env.DISCOVERY_REQUIRED_EVALUATION_VERSION?.trim();
  return raw || null;
}

export function isDiscoveryRequireRemoteUs(): boolean {
  return envFlagTrue("DISCOVERY_REQUIRE_REMOTE_US");
}

export function isDiscoveryRequireDirectPostingUrl(): boolean {
  return envFlagTrue("DISCOVERY_REQUIRE_DIRECT_POSTING_URL");
}

export function isDiscoveryRequireDescriptionHash(): boolean {
  return envFlagTrue("DISCOVERY_REQUIRE_DESCRIPTION_HASH");
}

/**
 * Any quality-gate flag implicitly requires stored GPT evidence.
 * A quality flag must never silently accept a job without stored evidence,
 * even if DISCOVERY_REQUIRE_GPT_EVALUATION is false.
 */
export function discoveryQualityGatesRequireStoredEvidence(): boolean {
  return (
    isDiscoveryGptEvaluationRequired() ||
    Boolean(getRequiredDiscoveryEvaluationVersion()) ||
    isDiscoveryRequireRemoteUs() ||
    isDiscoveryRequireDirectPostingUrl() ||
    isDiscoveryRequireDescriptionHash()
  );
}

export function resolveRequestedDiscoveryEvaluationVersion(
  requested?: string | null,
): string {
  const trimmed = requested?.trim();
  return trimmed || DEFAULT_GPT_EVALUATION_VERSION;
}

export function discoveryPreflightVersionConfig(requested?: string | null): {
  requested_evaluation_version: string;
  default_evaluation_version: string;
  required_evaluation_version: string | null;
} {
  return {
    requested_evaluation_version: resolveRequestedDiscoveryEvaluationVersion(requested),
    default_evaluation_version: DEFAULT_GPT_EVALUATION_VERSION,
    required_evaluation_version: getRequiredDiscoveryEvaluationVersion(),
  };
}
