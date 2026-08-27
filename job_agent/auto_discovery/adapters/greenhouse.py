"""Greenhouse boards-api adapter."""

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


class GreenhouseAdapter(BaseAtsAdapter):
    provider = "greenhouse"

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        token = (company.ats_org_id or "").strip()
        if not token:
            raise AdapterError("greenhouse ats_org_id (board token) required", category="validation")
        url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs"
        response = self.http.get(url)
        payload = response.json()
        jobs = payload.get("jobs") if isinstance(payload, dict) else None
        if not isinstance(jobs, list):
            raise AdapterError("greenhouse list response missing jobs", category="validation")

        out: list[LightweightCandidate] = []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            job_id = str(job.get("id") or "").strip()
            title = str(job.get("title") or "").strip()
            absolute = str(job.get("absolute_url") or "").strip()
            if not job_id or not title or not absolute:
                continue
            location = ""
            loc = job.get("location")
            if isinstance(loc, dict):
                location = str(loc.get("name") or "").strip()
            elif isinstance(loc, str):
                location = loc.strip()
            updated = str(job.get("updated_at") or "")[:10]
            posted = updated if re.fullmatch(r"\d{4}-\d{2}-\d{2}", updated or "") else ""
            out.append(
                LightweightCandidate(
                    client_candidate_id=f"greenhouse:{token}:{job_id}",
                    company=company.company_name,
                    title=title,
                    url=absolute,
                    source="greenhouse",
                    external_job_id=job_id,
                    location=location,
                    posted_date=posted,
                )
            )
        return out

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        token = (company.ats_org_id or "").strip()
        job_id = (candidate.external_job_id or "").strip()
        if not token or not job_id:
            raise AdapterError("greenhouse get_job requires board token and job id", category="validation")
        url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{job_id}"
        response = self.http.get(url)
        job = response.json()
        if not isinstance(job, dict):
            raise AdapterError("greenhouse job detail invalid", category="validation")
        content = job.get("content")
        description = _strip_html(str(content) if content is not None else "")
        location = candidate.location
        loc = job.get("location")
        if isinstance(loc, dict) and loc.get("name"):
            location = str(loc["name"]).strip()
        absolute = str(job.get("absolute_url") or candidate.url).strip()
        return LightweightCandidate(
            client_candidate_id=candidate.client_candidate_id,
            company=company.company_name,
            title=str(job.get("title") or candidate.title).strip(),
            url=absolute,
            source="greenhouse",
            external_job_id=str(job.get("id") or job_id),
            location=location,
            posted_date=candidate.posted_date,
            description=description or None,
        )
