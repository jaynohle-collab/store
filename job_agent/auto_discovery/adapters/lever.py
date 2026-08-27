"""Lever public postings API adapter."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from html import unescape

from job_agent.auto_discovery.adapters.base import BaseAtsAdapter
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, LightweightCandidate

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def _lever_description(job: dict) -> str:
    parts: list[str] = []
    plain = job.get("descriptionPlain")
    if isinstance(plain, str) and plain.strip():
        parts.append(plain.strip())
    else:
        desc = job.get("description")
        if isinstance(desc, str) and desc.strip():
            parts.append(_strip_html(desc))
    lists = job.get("lists")
    if isinstance(lists, list):
        for block in lists:
            if not isinstance(block, dict):
                continue
            text = block.get("text") or block.get("content")
            if isinstance(text, str) and text.strip():
                parts.append(_strip_html(text))
    return "\n".join(parts).strip()


class LeverAdapter(BaseAtsAdapter):
    provider = "lever"

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        site = (company.ats_org_id or "").strip()
        if not site:
            raise AdapterError("lever ats_org_id (company site) required", category="validation")
        url = f"https://api.lever.co/v0/postings/{site}"
        response = self.http.get(url, params={"mode": "json"})
        payload = response.json()
        if not isinstance(payload, list):
            raise AdapterError("lever list response must be a JSON array", category="validation")

        out: list[LightweightCandidate] = []
        for job in payload:
            if not isinstance(job, dict):
                continue
            job_id = str(job.get("id") or "").strip()
            title = str(job.get("text") or job.get("title") or "").strip()
            job_url = str(job.get("hostedUrl") or job.get("applyUrl") or "").strip()
            if not job_id or not title or not job_url:
                continue
            categories = job.get("categories") if isinstance(job.get("categories"), dict) else {}
            location = str(categories.get("location") or job.get("location") or "").strip()
            posted = ""
            created = job.get("createdAt")
            if isinstance(created, (int, float)):
                posted = (
                    datetime.fromtimestamp(created / 1000.0, tz=timezone.utc).date().isoformat()
                )
            out.append(
                LightweightCandidate(
                    client_candidate_id=f"lever:{site}:{job_id}",
                    company=company.company_name,
                    title=title,
                    url=job_url,
                    source="lever",
                    external_job_id=job_id,
                    location=location,
                    posted_date=posted,
                    description=_lever_description(job) or None,
                )
            )
        return out

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        if candidate.description:
            return candidate
        site = (company.ats_org_id or "").strip()
        job_id = (candidate.external_job_id or "").strip()
        if not site or not job_id:
            return candidate
        url = f"https://api.lever.co/v0/postings/{site}/{job_id}"
        response = self.http.get(url, params={"mode": "json"})
        job = response.json()
        if not isinstance(job, dict):
            return candidate
        return LightweightCandidate(
            client_candidate_id=candidate.client_candidate_id,
            company=company.company_name,
            title=str(job.get("text") or candidate.title).strip(),
            url=str(job.get("hostedUrl") or candidate.url).strip(),
            source="lever",
            external_job_id=str(job.get("id") or job_id),
            location=candidate.location,
            posted_date=candidate.posted_date,
            description=_lever_description(job) or None,
        )
