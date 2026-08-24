/**
 * Remote US nationwide eligibility for dashboard To Apply filtering.
 *
 * Classification rules are defined in remote_eligibility_spec.ts and shared
 * with the dashboard SQL remote predicate.
 */

import {
  matchesLegacyRemoteUsSqlLogic,
  matchesRemoteUsDashboardFilter,
  type RemoteFilterEvidence,
} from "./remote_eligibility_spec";

export type RemoteScope =
  | "US_NATIONWIDE"
  | "US_RESTRICTED"
  | "HYBRID"
  | "ONSITE"
  | "NON_US"
  | "UNKNOWN"
  | null
  | undefined;

export type RemoteEligibilityInput = {
  remote_scope?: RemoteScope;
  remote_status?: string | null;
  location?: string | null;
  posting_location?: string | null;
  canonical_location?: string | null;
  gpt_evaluation_id?: string | null;
};

function toFilterEvidence(input: RemoteEligibilityInput): RemoteFilterEvidence {
  return {
    remote_scope: input.remote_scope,
    gpt_evaluation_id: input.gpt_evaluation_id,
    remote_status: input.remote_status,
    posting_location: input.posting_location,
    canonical_location: input.canonical_location,
    location: input.location,
  };
}

function combinedLocationText(input: RemoteEligibilityInput): string {
  return [input.posting_location, input.canonical_location, input.location]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Pure legacy classifier — mirrors dashboard SQL legacy branch (~* patterns).
 */
export function classifyLegacyRemoteUsNationwide(input: RemoteEligibilityInput): boolean {
  return matchesLegacyRemoteUsSqlLogic(input.remote_status, combinedLocationText(input));
}

/**
 * Whether a posting qualifies for the default Remote US only To Apply view.
 */
export function isRemoteUsNationwideEligible(input: RemoteEligibilityInput): boolean {
  return matchesRemoteUsDashboardFilter(toFilterEvidence(input));
}

export {
  matchesLegacyRemoteUsSqlLogic,
  matchesRemoteUsDashboardFilter,
} from "./remote_eligibility_spec";
