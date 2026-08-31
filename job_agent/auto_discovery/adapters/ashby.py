"""Ashby posting-api adapter."""

from __future__ import annotations

import re
from html import unescape

from job_agent.auto_discovery.adapters.base import BaseAtsAdapter
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, LightweightCandidate

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def _ashby_description(job: dict) -> str:
    parts: list[str] = []
    for key in ("descriptionHtml", "descriptionPlain", "description"):
        raw = job.get(key)
        if isinstance(raw, str) and raw.strip():
            parts.append(_strip_html(raw) if "Html" in key or "<" in raw else raw.strip())
            break
    return " ".join(parts).strip()


class AshbyAdapter(BaseAtsAdapter):
    provider = "ashby"

    def __init__(self, http=None):
        super().__init__(http)
        self._list_cache: dict[str, list[LightweightCandidate]] = {}

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        name = (company.ats_org_id or "").strip()
        if not name:
            raise AdapterError("ashby ats_org_id (board name) required", category="validation")
        if name in self._list_cache:
            return list(self._list_cache[name])
        url = f"https://api.ashbyhq.com/posting-api/job-board/{name}"
        response = self.http.get(url)
        payload = response.json()
        jobs = payload.get("jobs") if isinstance(payload, dict) else None
        if not isinstance(jobs, list):
            raise AdapterError("ashby list response missing jobs", category="validation")

        out: list[LightweightCandidate] = []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            job_id = str(job.get("id") or job.get("jobId") or "").strip()
            title = str(job.get("title") or "").strip()
            job_url = str(job.get("jobUrl") or job.get("applyUrl") or "").strip()
            if not title or not job_url:
                continue
            if not job_id:
                job_id = job_url.rstrip("/").rsplit("/", 1)[-1]
            location = ""
            if isinstance(job.get("location"), str):
                location = job["location"].strip()
            elif job.get("locationName"):
                location = str(job.get("locationName") or "").strip()
            elif isinstance(job.get("address"), dict):
                location = str(job["address"].get("postalAddress") or "").strip()
            published = str(job.get("publishedAt") or job.get("updatedAt") or "")[:10]
            posted = published if re.fullmatch(r"\d{4}-\d{2}-\d{2}", published or "") else ""
            out.append(
                LightweightCandidate(
                    client_candidate_id=f"ashby:{name}:{job_id}",
                    company=company.company_name,
                    title=title,
                    url=job_url,
                    source="ashby",
                    external_job_id=job_id,
                    location=location,
                    posted_date=posted,
                    description=_ashby_description(job) or None,
                )
            )
        self._list_cache[name] = out
        return list(out)

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        if candidate.description:
            return candidate
        jobs = self.list_jobs(company)  # uses per-board cache
        for job in jobs:
            if job.external_job_id == candidate.external_job_id or job.url == candidate.url:
                if job.description:
                    return job
                break
        return candidate
