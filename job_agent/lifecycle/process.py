from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

from .resolver import CanonicalJobResolver, normalize_raw_job
from .types import DiscoveredJobResult, PersistencePlan, PostingDisposition


class DiscoveryRunStore(Protocol):
    async def save_discovery_run(self, payload: dict[str, Any]) -> dict[str, Any]: ...


async def process_discovered_job(
    raw_job: dict[str, Any],
    resolver: CanonicalJobResolver,
    *,
    match_score: float | None = None,
    persist: bool = True,
) -> DiscoveredJobResult:
    """Normalize → classify → (optional) persist a discovered job.

    Scoring remains separate: pass ``match_score`` from the ranking layer.
    """
    posting = normalize_raw_job(raw_job)
    classification = await resolver.classify_posting(posting)
    plan = resolver.build_persistence_plan(classification)

    result = DiscoveredJobResult(
        posting=posting,
        classification=classification,
        persistence_plan=plan,
        match_score=match_score,
    )

    if not persist:
        return result

    canonical, job_posting = await resolver.apply_persistence_plan(
        posting, plan, classification
    )
    # Ensure classification carries resolved ids after create.
    if canonical and not classification.canonical_job_id:
        classification.canonical_job_id = str(canonical.get("id"))
    if job_posting and classification.disposition == PostingDisposition.SAME_POSTING:
        classification.previous_posting_id = str(job_posting.get("id"))

    result.canonical_job = canonical
    result.job_posting = job_posting
    result.persisted = True
    return result


class DiscoveryRunTracker:
    """Accumulate disposition counts for a discovery execution."""

    def __init__(self, source: str = "chatgpt"):
        self.source = source
        self.started_at = datetime.now(timezone.utc)
        self.jobs_discovered = 0
        self.new_jobs = 0
        self.reposts = 0
        self.duplicates = 0
        self.metadata: dict[str, Any] = {}

    def record(self, result: DiscoveredJobResult) -> None:
        self.jobs_discovered += 1
        disposition = result.classification.disposition
        if disposition == PostingDisposition.NEW_JOB:
            self.new_jobs += 1
        elif disposition == PostingDisposition.REPOST:
            self.reposts += 1
        elif disposition == PostingDisposition.SAME_POSTING:
            self.duplicates += 1

    def to_payload(self, completed: bool = True) -> dict[str, Any]:
        completed_at = datetime.now(timezone.utc).isoformat() if completed else None
        return {
            "source": self.source,
            "started_at": self.started_at.isoformat(),
            "completed_at": completed_at,
            "jobs_discovered": self.jobs_discovered,
            "new_jobs": self.new_jobs,
            "reposts": self.reposts,
            "duplicates": self.duplicates,
            "metadata": self.metadata,
        }

    async def persist(self, store: DiscoveryRunStore) -> dict[str, Any]:
        return await store.save_discovery_run(self.to_payload(completed=True))


def to_apply_signals(
    *,
    posting: dict[str, Any] | None,
    match_score: float | None,
    match_threshold: float,
    has_application_for_posting: bool,
) -> dict[str, Any]:
    """Data needed to compute 'to apply' — policy stays in Python later."""
    status = str((posting or {}).get("posting_status") or "active").lower()
    active = status not in {"closed", "expired", "removed", "inactive", "ignored"}
    above = match_score is not None and match_score >= match_threshold
    return {
        "active_posting": active,
        "match_score": match_score,
        "match_above_threshold": above,
        "has_application_for_posting": has_application_for_posting,
        "not_ignored_or_closed": active,
        "candidate_to_apply": bool(
            active and above and not has_application_for_posting
        ),
    }
