from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

from .classifier import PostingLifecycleClassifier
from .types import (
    LifecycleClassification,
    NormalizedLifecyclePosting,
    PersistencePlan,
    PostingDisposition,
)
from .url import normalize_url
from ..memory.fingerprint import (
    compute_description_hash,
    normalize_company_key,
    normalize_title_key,
)
from ..utils.normalization import extract_role_family, normalize_location
from .types import parse_iso_date


class LifecycleStore(Protocol):
    async def find_posting_by_normalized_url(self, normalized_url: str) -> dict[str, Any] | None: ...
    async def find_posting_by_external_id(
        self, source: str, external_job_id: str
    ) -> dict[str, Any] | None: ...
    async def find_canonical_jobs(
        self, company_key: str, normalized_title: str
    ) -> list[dict[str, Any]]: ...
    async def list_postings_for_canonical(
        self, canonical_job_id: str
    ) -> list[dict[str, Any]]: ...
    async def list_recent_postings(self, days: int = 36500, limit: int = 500) -> list[dict[str, Any]]: ...
    async def save_canonical_job(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def save_job_posting(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def update_job_posting(self, payload: dict[str, Any]) -> dict[str, Any] | None: ...
    async def touch_canonical_job(
        self, canonical_job_id: str, last_seen_at: str | None = None
    ) -> dict[str, Any] | None: ...


class CanonicalJobResolver:
    """Resolve or create canonical jobs and apply persistence plans."""

    def __init__(
        self,
        store: LifecycleStore,
        classifier: PostingLifecycleClassifier | None = None,
    ):
        self.store = store
        self.classifier = classifier or PostingLifecycleClassifier()

    async def classify_posting(
        self,
        posting: NormalizedLifecyclePosting,
    ) -> LifecycleClassification:
        existing_postings = await self._gather_candidate_postings(posting)
        existing_canonicals = await self.store.find_canonical_jobs(
            posting.company_key,
            posting.normalized_title,
        )
        # Enrich postings with company/title from canonicals when missing.
        canonical_by_id = {str(c.get("id")): c for c in existing_canonicals}
        enriched: list[dict[str, Any]] = []
        for item in existing_postings:
            row = dict(item)
            cid = str(row.get("canonical_job_id") or "")
            if cid in canonical_by_id:
                canon = canonical_by_id[cid]
                row.setdefault("company", canon.get("company"))
                row.setdefault("company_key", canon.get("company_key"))
                row.setdefault("title", canon.get("title"))
                row.setdefault("normalized_title", canon.get("normalized_title"))
                row.setdefault("role_family", canon.get("role_family"))
            enriched.append(row)

        return self.classifier.classify(posting, enriched, existing_canonicals)

    def build_persistence_plan(
        self,
        classification: LifecycleClassification,
    ) -> PersistencePlan:
        if classification.disposition == PostingDisposition.SAME_POSTING:
            return PersistencePlan(
                create_canonical=False,
                create_posting=False,
                update_posting_id=classification.previous_posting_id,
                touch_canonical_id=classification.canonical_job_id,
                is_repost=False,
                supersedes_posting_id=None,
                disposition=PostingDisposition.SAME_POSTING,
            )
        if classification.disposition == PostingDisposition.REPOST:
            return PersistencePlan(
                create_canonical=False,
                create_posting=True,
                update_posting_id=None,
                touch_canonical_id=classification.canonical_job_id,
                is_repost=True,
                supersedes_posting_id=classification.previous_posting_id,
                disposition=PostingDisposition.REPOST,
            )
        return PersistencePlan(
            create_canonical=True,
            create_posting=True,
            update_posting_id=None,
            touch_canonical_id=None,
            is_repost=False,
            supersedes_posting_id=None,
            disposition=PostingDisposition.NEW_JOB,
        )

    async def apply_persistence_plan(
        self,
        posting: NormalizedLifecyclePosting,
        plan: PersistencePlan,
        classification: LifecycleClassification,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        now = datetime.now(timezone.utc).isoformat()
        canonical: dict[str, Any] | None = classification.matched_canonical
        job_posting: dict[str, Any] | None = None

        if plan.create_canonical:
            canonical = await self.store.save_canonical_job(
                {
                    "company": posting.company,
                    "company_key": posting.company_key,
                    "title": posting.title,
                    "normalized_title": posting.normalized_title,
                    "location": posting.location,
                    "normalized_location": posting.normalized_location,
                    "role_family": posting.role_family,
                    "first_seen_at": now,
                    "last_seen_at": now,
                }
            )
        elif plan.touch_canonical_id:
            canonical = await self.store.touch_canonical_job(plan.touch_canonical_id, now)
            if canonical is None and classification.canonical_job_id:
                canonical = {"id": classification.canonical_job_id}

        canonical_id = (
            (canonical or {}).get("id")
            or plan.touch_canonical_id
            or classification.canonical_job_id
        )

        if plan.update_posting_id:
            # SAME_POSTING: refresh last_seen_at; keep first_seen_at stable.
            payload: dict[str, Any] = {
                "id": plan.update_posting_id,
                "last_seen_at": now,
            }
            if posting.description is not None:
                payload["description"] = posting.description
            if posting.description_hash is not None:
                payload["description_hash"] = posting.description_hash
            if posting.location is not None:
                payload["location"] = posting.location
            if posting.remote_status is not None:
                payload["remote_status"] = posting.remote_status
            if posting.salary is not None:
                payload["salary"] = posting.salary
            if posting.posted_date is not None:
                payload["posted_date"] = posting.posted_date.isoformat()
            if posting.url is not None:
                payload["url"] = posting.url
            if posting.normalized_url is not None:
                payload["normalized_url"] = posting.normalized_url
            job_posting = await self.store.update_job_posting(payload)
            return canonical, job_posting

        if plan.create_posting:
            if not canonical_id:
                raise RuntimeError("Cannot create posting without canonical_job_id")
            job_posting = await self.store.save_job_posting(
                {
                    "canonical_job_id": str(canonical_id),
                    "source": posting.source,
                    "external_job_id": posting.external_job_id,
                    "url": posting.url,
                    "normalized_url": posting.normalized_url,
                    "description": posting.description,
                    "description_hash": posting.description_hash,
                    "location": posting.location,
                    "remote_status": posting.remote_status,
                    "salary": posting.salary,
                    "posted_date": posting.posted_date.isoformat() if posting.posted_date else None,
                    "posting_status": "active",
                    "is_repost": plan.is_repost,
                    "supersedes_posting_id": plan.supersedes_posting_id,
                    "first_seen_at": now,
                    "last_seen_at": now,
                }
            )
        return canonical, job_posting

    async def _gather_candidate_postings(
        self,
        posting: NormalizedLifecyclePosting,
    ) -> list[dict[str, Any]]:
        found: dict[str, dict[str, Any]] = {}

        def add(rows: list[dict[str, Any]] | dict[str, Any] | None) -> None:
            if rows is None:
                return
            if isinstance(rows, dict):
                rows = [rows]
            for row in rows:
                if not row:
                    continue
                key = str(row.get("id") or id(row))
                found[key] = row

        if posting.normalized_url:
            add(await self.store.find_posting_by_normalized_url(posting.normalized_url))
        if posting.source and posting.external_job_id:
            add(
                await self.store.find_posting_by_external_id(
                    posting.source, posting.external_job_id
                )
            )

        canonicals = await self.store.find_canonical_jobs(
            posting.company_key, posting.normalized_title
        )
        for canonical in canonicals:
            cid = canonical.get("id")
            if cid:
                add(await self.store.list_postings_for_canonical(str(cid)))

        # Broad recent window so classifier can see other company postings.
        add(await self.store.list_recent_postings(days=36500, limit=500))
        return list(found.values())


def normalize_raw_job(raw: dict[str, Any]) -> NormalizedLifecyclePosting:
    """Normalize ChatGPT / agent raw job JSON into a lifecycle posting."""
    company = str(raw.get("company") or raw.get("company_name") or "").strip()
    title = str(raw.get("title") or "").strip()
    source = str(raw.get("source") or "unknown").strip() or "unknown"
    url = _optional_str(raw.get("url"))
    description = _optional_str(raw.get("description"))
    location = _optional_str(raw.get("location"))
    external_job_id = extract_external_job_id(raw)
    remote_status = _optional_str(raw.get("remote_status"))
    salary = _optional_str(raw.get("salary"))
    posted_date = parse_iso_date(raw.get("posted_date"))

    return NormalizedLifecyclePosting(
        company=company,
        company_key=normalize_company_key(company),
        title=title,
        normalized_title=normalize_title_key(title),
        role_family=extract_role_family(title),
        location=location,
        normalized_location=normalize_location(location),
        source=source,
        url=url,
        normalized_url=normalize_url(url),
        external_job_id=external_job_id,
        description=description,
        description_hash=compute_description_hash(description),
        remote_status=remote_status,
        salary=salary,
        posted_date=posted_date,
        raw=dict(raw),
    )


def extract_external_job_id(raw: dict[str, Any]) -> str | None:
    """Preserve ATS / board posting IDs when present."""
    direct_keys = (
        "external_job_id",
        "external_id",
        "job_id",
        "requisition_id",
        "greenhouse_id",
        "lever_id",
        "ashby_id",
        "linkedin_job_id",
        "ats_id",
    )
    for key in direct_keys:
        value = raw.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()

    metadata = raw.get("metadata")
    if isinstance(metadata, dict):
        for key in direct_keys:
            value = metadata.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
    return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
