"""Workday CXS public jobs adapter."""

from __future__ import annotations

import json
import re
from html import unescape
from urllib.parse import urlparse

from job_agent.auto_discovery.adapters.base import BaseAtsAdapter
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, LightweightCandidate

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def parse_workday_org(ats_org_id: str, careers_url: str | None) -> tuple[str, str, str]:
    """Return (tenant, site, host) from ats_org_id.

    Formats:
    - ``tenant|site``
    - ``tenant|site|host``
    - JSON ``{"tenant": "...", "site": "...", "host": "..."}``
    """
    raw = (ats_org_id or "").strip()
    if not raw:
        raise AdapterError("workday ats_org_id required", category="validation")

    tenant = ""
    site = ""
    host = ""

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AdapterError("workday ats_org_id JSON invalid", category="validation") from exc
        if not isinstance(data, dict):
            raise AdapterError("workday ats_org_id JSON must be an object", category="validation")
        tenant = str(data.get("tenant") or "").strip()
        site = str(data.get("site") or "").strip()
        host = str(data.get("host") or "").strip()
    else:
        parts = [p.strip() for p in raw.split("|")]
        if len(parts) < 2:
            raise AdapterError(
                "workday ats_org_id must be tenant|site or JSON",
                category="validation",
            )
        tenant, site = parts[0], parts[1]
        if len(parts) >= 3:
            host = parts[2]

    if not tenant or not site:
        raise AdapterError("workday tenant and site required", category="validation")

    if not host and careers_url:
        parsed = urlparse(careers_url)
        if parsed.hostname and "myworkdayjobs.com" in parsed.hostname.lower():
            host = parsed.hostname.lower()

    if not host:
        # Common public CXS host pattern; still SSRF-checked as *.myworkdayjobs.com.
        host = f"{tenant}.wd1.myworkdayjobs.com"

    host = host.lower().removeprefix("https://").removeprefix("http://").split("/")[0]
    return tenant, site, host


def _job_id_and_url(job: dict, host: str, site: str) -> tuple[str, str]:
    path = str(job.get("externalPath") or "").strip()
    job_id = str(job.get("id") or job.get("jobId") or "").strip()
    if path:
        job_url = f"https://{host}/{site}{path if path.startswith('/') else '/' + path}"
        if not job_id:
            job_id = path.rstrip("/").rsplit("/", 1)[-1]
        return job_id, job_url
    job_url = str(job.get("externalUrl") or job.get("url") or "").strip()
    if not job_id and job_url:
        job_id = job_url.rstrip("/").rsplit("/", 1)[-1]
    return job_id, job_url


class WorkdayAdapter(BaseAtsAdapter):
    provider = "workday"

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        tenant, site, host = parse_workday_org(company.ats_org_id or "", company.careers_url)
        url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
        out: list[LightweightCandidate] = []
        offset = 0
        page_size = 20
        max_pages = 25

        for _ in range(max_pages):
            response = self.http.post(
                url,
                json={"appliedFacets": {}, "limit": page_size, "offset": offset, "searchText": ""},
            )
            payload = response.json()
            if not isinstance(payload, dict):
                raise AdapterError("workday list response invalid", category="validation")
            jobs = payload.get("jobPostings") or payload.get("jobs") or []
            if not isinstance(jobs, list) or not jobs:
                break
            for job in jobs:
                if not isinstance(job, dict):
                    continue
                title = str(job.get("title") or "").strip()
                job_id, job_url = _job_id_and_url(job, host, site)
                if not title or not job_url:
                    continue
                if not job_id:
                    job_id = job_url
                locations = job.get("locationsText") or job.get("location") or ""
                if isinstance(locations, list):
                    location = ", ".join(str(x) for x in locations)
                else:
                    location = str(locations).strip()
                posted_raw = str(job.get("postedOn") or job.get("postedDate") or "")[:10]
                posted = posted_raw if re.fullmatch(r"\d{4}-\d{2}-\d{2}", posted_raw or "") else ""
                out.append(
                    LightweightCandidate(
                        client_candidate_id=f"workday:{tenant}:{site}:{job_id}",
                        company=company.company_name,
                        title=title,
                        url=job_url,
                        source="workday",
                        external_job_id=job_id,
                        location=location,
                        posted_date=posted,
                    )
                )
            total = int(payload.get("total") or 0)
            offset += page_size
            if offset >= total or len(jobs) < page_size:
                break
        return out

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        tenant, site, host = parse_workday_org(company.ats_org_id or "", company.careers_url)
        path = ""
        parsed = urlparse(candidate.url)
        if parsed.path:
            marker = f"/{site}"
            idx = parsed.path.lower().find(marker.lower())
            if idx >= 0:
                path = parsed.path[idx + len(marker) :]
            else:
                path = parsed.path
        if not path:
            return candidate

        detail_url = (
            f"https://{host}/wday/cxs/{tenant}/{site}"
            f"{path if path.startswith('/') else '/' + path}"
        )
        try:
            response = self.http.get(detail_url)
            payload = response.json()
        except AdapterError:
            return candidate
        if not isinstance(payload, dict):
            return candidate
        posting = (
            payload.get("jobPostingInfo")
            if isinstance(payload.get("jobPostingInfo"), dict)
            else payload
        )
        description = _strip_html(
            str(
                posting.get("jobDescription")
                or posting.get("description")
                or posting.get("jobDescriptionText")
                or ""
            )
        )
        title = str(posting.get("title") or candidate.title).strip()
        return LightweightCandidate(
            client_candidate_id=candidate.client_candidate_id,
            company=company.company_name,
            title=title,
            url=candidate.url,
            source="workday",
            external_job_id=candidate.external_job_id,
            location=candidate.location,
            posted_date=candidate.posted_date,
            description=description or None,
        )
