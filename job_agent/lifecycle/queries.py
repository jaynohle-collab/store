from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

from .types import parse_iso_datetime


class QueryStore(Protocol):
    async def list_recent_postings(self, days: int = 1, limit: int = 100) -> list[dict[str, Any]]: ...
    async def list_reposted_postings(self, limit: int = 50) -> list[dict[str, Any]]: ...
    async def list_reposts_with_prior_applications(self, limit: int = 50) -> list[dict[str, Any]]: ...
    async def search_job_postings(self, query: str, limit: int = 50) -> list[dict[str, Any]]: ...
    async def list_applications(self, **filters: Any) -> list[dict[str, Any]]: ...
    async def list_discovery_runs(self, limit: int = 20) -> list[dict[str, Any]]: ...
    async def find_posting_by_normalized_url(self, normalized_url: str) -> dict[str, Any] | None: ...


INTERVIEW_STATUSES = frozenset(
    {
        "recruiter_screen",
        "technical_screen",
        "interview",
        "onsite",
    }
)

APPLIED_OR_LATER = frozenset(
    {
        "applied",
        "recruiter_screen",
        "technical_screen",
        "interview",
        "onsite",
        "offer",
        "rejected",
        "withdrawn",
        "closed",
    }
)


class LifecycleQueryService:
    """Read helpers for the future dashboard (no UI; data only)."""

    def __init__(self, store: QueryStore):
        self.store = store

    async def jobs_discovered_today(self) -> list[dict[str, Any]]:
        return await self.store.list_recent_postings(days=1, limit=500)

    async def new_matching_jobs(
        self,
        *,
        match_scores: dict[str, float],
        threshold: float,
    ) -> list[dict[str, Any]]:
        postings = await self.store.list_recent_postings(days=30, limit=500)
        results = []
        for posting in postings:
            if posting.get("is_repost"):
                continue
            pid = str(posting.get("id"))
            score = match_scores.get(pid)
            if score is not None and score >= threshold:
                results.append({**posting, "match_score": score})
        return results

    async def jobs_still_need_apply(
        self,
        *,
        match_scores: dict[str, float],
        threshold: float,
    ) -> list[dict[str, Any]]:
        postings = await self.store.list_recent_postings(days=90, limit=500)
        applications = await self.store.list_applications(limit=500)
        applied_postings = {str(a.get("posting_id")) for a in applications}
        results = []
        for posting in postings:
            status = str(posting.get("posting_status") or "active").lower()
            if status in {"closed", "ignored", "expired", "removed", "inactive"}:
                continue
            pid = str(posting.get("id"))
            if pid in applied_postings:
                continue
            score = match_scores.get(pid)
            if score is None or score < threshold:
                continue
            results.append({**posting, "match_score": score})
        return results

    async def jobs_already_applied(self) -> list[dict[str, Any]]:
        apps = await self.store.list_applications(limit=500)
        return [a for a in apps if str(a.get("status")) in APPLIED_OR_LATER]

    async def jobs_currently_interviewing(self) -> list[dict[str, Any]]:
        apps = await self.store.list_applications(limit=500)
        return [a for a in apps if str(a.get("status")) in INTERVIEW_STATUSES]

    async def reposted_jobs(self) -> list[dict[str, Any]]:
        return await self.store.list_reposted_postings(limit=100)

    async def reposted_jobs_previously_applied(self) -> list[dict[str, Any]]:
        return await self.store.list_reposts_with_prior_applications(limit=100)

    async def search(self, query: str) -> list[dict[str, Any]]:
        return await self.store.search_job_postings(query, limit=50)

    async def find_applied_url(self, query: str | None = None) -> list[dict[str, Any]]:
        apps = await self.jobs_already_applied()
        if not query:
            return [
                {
                    "application_id": a.get("id"),
                    "posting_id": a.get("posting_id"),
                    "application_url": a.get("application_url"),
                    "status": a.get("status"),
                }
                for a in apps
            ]
        q = query.lower()
        return [
            {
                "application_id": a.get("id"),
                "posting_id": a.get("posting_id"),
                "application_url": a.get("application_url"),
                "status": a.get("status"),
            }
            for a in apps
            if q in str(a.get("application_url") or "").lower()
        ]

    async def daily_counts(self, limit_runs: int = 30) -> list[dict[str, Any]]:
        runs = await self.store.list_discovery_runs(limit=limit_runs)
        return [
            {
                "id": run.get("id"),
                "source": run.get("source"),
                "started_at": run.get("started_at"),
                "jobs_discovered": run.get("jobs_discovered"),
                "new_jobs": run.get("new_jobs"),
                "reposts": run.get("reposts"),
                "duplicates": run.get("duplicates"),
            }
            for run in runs
        ]
