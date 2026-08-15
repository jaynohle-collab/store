"""In-memory lifecycle store for deterministic unit tests."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id() -> str:
    return str(uuid.uuid4())


class InMemoryLifecycleStore:
    def __init__(self) -> None:
        self.canonical_jobs: dict[str, dict[str, Any]] = {}
        self.job_postings: dict[str, dict[str, Any]] = {}
        self.applications: dict[str, dict[str, Any]] = {}
        self.application_events: dict[str, dict[str, Any]] = {}
        self.discovery_runs: dict[str, dict[str, Any]] = {}

    async def save_canonical_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        row = {
            "id": _id(),
            "created_at": _now(),
            "updated_at": _now(),
            **payload,
        }
        self.canonical_jobs[row["id"]] = row
        return dict(row)

    async def touch_canonical_job(
        self, canonical_job_id: str, last_seen_at: str | None = None
    ) -> dict[str, Any] | None:
        row = self.canonical_jobs.get(canonical_job_id)
        if not row:
            return None
        row["last_seen_at"] = last_seen_at or _now()
        row["updated_at"] = _now()
        return dict(row)

    async def find_canonical_jobs(
        self, company_key: str, normalized_title: str
    ) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.canonical_jobs.values()
            if row.get("company_key") == company_key
            and row.get("normalized_title") == normalized_title
        ]

    async def find_canonical_jobs_by_company(
        self, company_key: str, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self.canonical_jobs.values()
            if row.get("company_key") == company_key
        ]
        rows.sort(key=lambda r: str(r.get("last_seen_at") or ""), reverse=True)
        return rows[offset : offset + limit]

    async def get_job_posting(self, posting_id: str) -> dict[str, Any] | None:
        row = self.job_postings.get(posting_id)
        return dict(row) if row else None

    async def save_job_posting(self, payload: dict[str, Any]) -> dict[str, Any]:
        row = {
            "id": _id(),
            "created_at": _now(),
            "updated_at": _now(),
            "is_repost": False,
            "posting_status": "active",
            **payload,
        }
        self.job_postings[row["id"]] = row
        return dict(row)

    async def update_job_posting(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        row = self.job_postings.get(str(payload["id"]))
        if not row:
            return None
        for key, value in payload.items():
            if key == "id" or value is None:
                continue
            row[key] = value
        row["updated_at"] = _now()
        return dict(row)

    async def find_posting_by_normalized_url(self, normalized_url: str) -> dict[str, Any] | None:
        for row in self.job_postings.values():
            if row.get("normalized_url") == normalized_url:
                return dict(row)
        return None

    async def find_posting_by_external_id(
        self, source: str, external_job_id: str
    ) -> dict[str, Any] | None:
        for row in self.job_postings.values():
            if row.get("source") == source and row.get("external_job_id") == external_job_id:
                return dict(row)
        return None

    async def list_postings_for_canonical(self, canonical_job_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.job_postings.values()
            if str(row.get("canonical_job_id")) == str(canonical_job_id)
        ]

    async def list_recent_postings(self, days: int = 36500, limit: int = 500) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.job_postings.values()]
        for row in rows:
            cid = str(row.get("canonical_job_id") or "")
            canon = self.canonical_jobs.get(cid)
            if canon:
                row.setdefault("company", canon.get("company"))
                row.setdefault("company_key", canon.get("company_key"))
                row.setdefault("title", canon.get("title"))
                row.setdefault("normalized_title", canon.get("normalized_title"))
                row.setdefault("canonical_title", canon.get("title"))
                row.setdefault("role_family", canon.get("role_family"))
        return rows[:limit]

    async def search_job_postings(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        q = query.lower()
        rows = await self.list_recent_postings(limit=1000)
        return [r for r in rows if q in str(r).lower()][:limit]

    async def list_reposted_postings(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = await self.list_recent_postings(limit=1000)
        return [r for r in rows if r.get("is_repost")][:limit]

    async def list_reposts_with_prior_applications(self, limit: int = 50) -> list[dict[str, Any]]:
        results = []
        for posting in await self.list_reposted_postings(limit=1000):
            cid = str(posting.get("canonical_job_id"))
            prior = [
                a
                for a in self.applications.values()
                if str(a.get("canonical_job_id")) == cid
                and str(a.get("posting_id")) != str(posting.get("id"))
            ]
            if prior:
                row = dict(posting)
                row["prior_application_id"] = prior[0].get("id")
                row["prior_application_status"] = prior[0].get("status")
                row["prior_posting_id"] = prior[0].get("posting_id")
                results.append(row)
        return results[:limit]

    async def record_application(self, payload: dict[str, Any]) -> dict[str, Any]:
        posting = self.job_postings.get(str(payload["posting_id"]))
        if posting is None:
            raise ValueError(f"posting_id {payload['posting_id']} does not exist")
        if str(posting.get("canonical_job_id")) != str(payload["canonical_job_id"]):
            raise ValueError(
                f"posting_id {payload['posting_id']} belongs to canonical_job_id "
                f"{posting.get('canonical_job_id')}, not {payload['canonical_job_id']}"
            )
        row = {
            "id": _id(),
            "created_at": _now(),
            "updated_at": _now(),
            "status": "planned",
            **payload,
        }
        self.applications[row["id"]] = row
        return dict(row)

    async def get_application(self, application_id: str) -> dict[str, Any] | None:
        row = self.applications.get(application_id)
        return dict(row) if row else None

    async def list_applications(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.applications.values()]
        if filters.get("status"):
            rows = [r for r in rows if r.get("status") == filters["status"]]
        if filters.get("canonical_job_id"):
            rows = [
                r
                for r in rows
                if str(r.get("canonical_job_id")) == str(filters["canonical_job_id"])
            ]
        if filters.get("posting_id"):
            rows = [r for r in rows if str(r.get("posting_id")) == str(filters["posting_id"])]
        limit = int(filters.get("limit") or 500)
        return rows[:limit]

    async def update_application_status(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        row = self.applications.get(str(payload["id"]))
        if not row:
            return None
        row["status"] = payload["status"]
        if payload.get("notes") is not None:
            row["notes"] = payload["notes"]
        if payload.get("applied_at") is not None:
            row["applied_at"] = payload["applied_at"]
        row["updated_at"] = _now()
        return dict(row)

    async def add_application_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        row = {
            "id": _id(),
            "created_at": _now(),
            "metadata": {},
            **payload,
        }
        self.application_events[row["id"]] = row
        return dict(row)

    async def list_application_events(self, application_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.application_events.values()
            if str(row.get("application_id")) == str(application_id)
        ]

    async def save_discovery_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        row = {"id": _id(), "created_at": _now(), **payload}
        self.discovery_runs[row["id"]] = row
        return dict(row)

    async def list_discovery_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        return [dict(r) for r in list(self.discovery_runs.values())[:limit]]
