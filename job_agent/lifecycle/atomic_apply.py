"""Build MCP apply_discovery_batch_job_persistence payloads from Python decisions.

Python owns classify/score decisions. MCP owns atomic persistence + provenance.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .evaluation_service import PROFILE_VERSION, SCORING_VERSION
from .types import DiscoveredJobResult


def build_atomic_apply_fields(
    result: DiscoveredJobResult,
    *,
    recommendation: str,
    reason: str,
    score_breakdown: dict[str, Any] | None = None,
    scoring_version: str = SCORING_VERSION,
    profile_version: str = PROFILE_VERSION,
) -> dict[str, Any]:
    """Translate a non-persisted lifecycle result into worker apply fields."""
    plan = result.persistence_plan
    posting = result.posting
    fields: dict[str, Any] = {}

    if plan.create_canonical:
        fields["create_canonical"] = {
            "company": posting.company,
            "company_key": posting.company_key,
            "title": posting.title,
            "normalized_title": posting.normalized_title,
            "location": posting.location,
            "normalized_location": posting.normalized_location,
            "role_family": posting.role_family,
        }

    if plan.touch_canonical_id and not plan.create_canonical:
        fields["touch_canonical_id"] = plan.touch_canonical_id

    if plan.create_posting:
        create_posting: dict[str, Any] = {
            "use_new_canonical": bool(plan.create_canonical),
            "source": posting.source,
            "external_job_id": posting.external_job_id,
            "url": posting.url,
            "normalized_url": posting.normalized_url,
            "description": posting.description,
            "description_hash": posting.description_hash,
            "location": posting.location,
            "remote_status": posting.remote_status,
            "salary": posting.salary,
            "posted_date": (
                posting.posted_date.isoformat() if posting.posted_date else None
            ),
            "posting_status": "active",
            "is_repost": plan.is_repost,
            "supersedes_posting_id": plan.supersedes_posting_id,
        }
        if not plan.create_canonical and plan.touch_canonical_id:
            create_posting["canonical_job_id"] = plan.touch_canonical_id
        fields["create_posting"] = create_posting

    if plan.update_posting_id:
        update_posting: dict[str, Any] = {
            "id": plan.update_posting_id,
            "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
        if posting.description is not None:
            update_posting["description"] = posting.description
        if posting.description_hash is not None:
            update_posting["description_hash"] = posting.description_hash
        if posting.location is not None:
            update_posting["location"] = posting.location
        if posting.remote_status is not None:
            update_posting["remote_status"] = posting.remote_status
        if posting.salary is not None:
            update_posting["salary"] = posting.salary
        if posting.posted_date is not None:
            update_posting["posted_date"] = posting.posted_date.isoformat()
        if posting.url is not None:
            update_posting["url"] = posting.url
        if posting.normalized_url is not None:
            update_posting["normalized_url"] = posting.normalized_url
        fields["update_posting"] = update_posting

    # Persist profile-v1 evaluation atomically with the posting when mutating.
    if plan.create_posting or plan.update_posting_id:
        eval_metadata: dict[str, Any] = {
            "disposition": plan.disposition.value,
            "canonical_similarity_score": result.classification.canonical_similarity_score,
        }
        if score_breakdown is not None:
            eval_metadata["score_breakdown"] = score_breakdown
        fields["evaluation"] = {
            "use_resolved_posting": True,
            "match_score": result.match_score,
            "recommendation": recommendation,
            "reason": reason,
            "scoring_version": scoring_version,
            "profile_version": profile_version,
            "metadata": eval_metadata,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }

    return fields
