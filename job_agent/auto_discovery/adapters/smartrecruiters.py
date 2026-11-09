"""Read-only SmartRecruiters public Posting API adapter.

Uses only the documented /v1/companies/{company}/postings endpoints. No API
key, internal-posting access, application submission, or third-party job board.
https://developers.smartrecruiters.com/docs/endpoints
"""

from __future__ import annotations

import re
from dataclasses import replace
from html import unescape
from urllib.parse import urlparse

from job_agent.auto_discovery.adapters.base import BaseAtsAdapter
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, LightweightCandidate

_ORG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z")
_JOB_ID_RE = re.compile(r"[0-9]{1,32}\Z")
_TAG_RE = re.compile(r"<[^>]+>")
_PAGE_SIZE = 100
_DEFAULT_MAX_LISTINGS = 300
_MAX_LISTINGS = 5000
_COUNTRIES = {
    "US": "United States", "USA": "United States", "CA": "Canada",
    "GB": "United Kingdom", "UK": "United Kingdom", "DE": "Germany",
    "FR": "France", "IN": "India", "AU": "Australia", "NZ": "New Zealand",
    "PL": "Poland", "NL": "Netherlands", "IE": "Ireland", "ES": "Spain",
    "PT": "Portugal", "BR": "Brazil", "MX": "Mexico", "SG": "Singapore",
}


def _company_identifier(company: CompanyRecord) -> str:
    org = (company.ats_org_id or "").strip()
    if not _ORG_RE.fullmatch(org):
        raise AdapterError("smartrecruiters requires a valid company identifier", category="validation")
    return org


def _location(job: dict) -> str:
    location = job.get("location")
    if not isinstance(location, dict):
        return location.strip() if isinstance(location, str) else ""
    country = str(location.get("country") or "").strip()
    country_code = country.upper() if re.fullmatch(r"[A-Za-z]{2,3}", country) else ""
    country = _COUNTRIES.get(country.upper(), country)
    parts = [str(location.get(key) or "").strip() for key in ("city", "region")]
    parts.append(country)
    text = ", ".join(part for part in parts if part)
    # Preserve structured scope even when a foreign city/region matches a US
    # place name (e.g. London, ON, CA). Ranking checks this before heuristics.
    if country_code:
        text += f" (country: {country_code})"
    # A remote flag alone never grants US eligibility.
    if location.get("hybrid") is True and not re.search(r"\bhybrid\b", text, re.I):
        text = f"Hybrid - {text}" if text else "Hybrid"
    elif location.get("remote") is True and not re.search(r"\bremote\b", text, re.I):
        text = f"Remote - {text}" if text else "Remote"
    return text


def _description(job: dict) -> str:
    ad = job.get("jobAd")
    sections = ad.get("sections") if isinstance(ad, dict) else None
    if not isinstance(sections, dict):
        return ""
    parts = []
    for key in ("companyDescription", "jobDescription", "qualifications", "additionalInformation"):
        section = sections.get(key)
        text = section.get("text") if isinstance(section, dict) else None
        if isinstance(text, str) and text.strip():
            parts.append(re.sub(r"\s+", " ", _TAG_RE.sub(" ", unescape(text))).strip())
    return "\n".join(parts)


def _posting_url(job: dict, org: str, job_id: str) -> str:
    """Keep only a direct, matching ATS posting URL, never an API/ref URL."""
    raw = job.get("applyUrl")
    if isinstance(raw, str):
        try:
            parsed = urlparse(raw.strip())
            segments = parsed.path.strip("/").split("/")
            if (
                parsed.scheme == "https"
                and parsed.hostname in {"jobs.smartrecruiters.com", "www.smartrecruiters.com"}
                and parsed.port in (None, 443)
                and not parsed.username and not parsed.password
                and len(segments) == 2 and segments[0].lower() == org.lower()
                and re.fullmatch(re.escape(job_id) + r"(?:-[^/]+)?", segments[1])
            ):
                return raw.strip()
        except ValueError:
            pass
    # SmartRecruiters accepts the numeric posting ID without its optional title slug.
    return f"https://jobs.smartrecruiters.com/{org}/{job_id}"


class SmartRecruitersAdapter(BaseAtsAdapter):
    provider = "smartrecruiters"

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        org = _company_identifier(company)
        cap = min(_MAX_LISTINGS, max(0, self.max_listings if self.max_listings is not None
                                    else _DEFAULT_MAX_LISTINGS))
        out: list[LightweightCandidate] = []
        seen: set[str] = set()
        offset = 0
        while offset < cap:
            limit = min(_PAGE_SIZE, cap - offset)
            response = self.http.get(
                f"https://api.smartrecruiters.com/v1/companies/{org}/postings",
                params={"limit": limit, "offset": offset},
            )
            try:
                payload = response.json()
            except ValueError:
                raise AdapterError("smartrecruiters list response is not JSON", category="validation") from None
            jobs = payload.get("content") if isinstance(payload, dict) else None
            if not isinstance(jobs, list):
                raise AdapterError("smartrecruiters list response missing content", category="validation")
            if not jobs:
                break
            new_ids = 0
            for job in jobs[:limit]:
                if not isinstance(job, dict):
                    continue
                job_id = str(job.get("id") or "").strip()
                title = str(job.get("name") or "").strip()
                if not _JOB_ID_RE.fullmatch(job_id) or job_id in seen:
                    continue
                seen.add(job_id)
                new_ids += 1
                if not title or job.get("active") is False or job.get("visibility", "PUBLIC") != "PUBLIC":
                    continue
                owner = job.get("company")
                if isinstance(owner, dict) and owner.get("identifier") and str(owner["identifier"]).lower() != org.lower():
                    continue
                date = str(job.get("releasedDate") or "")[:10]
                out.append(LightweightCandidate(
                    client_candidate_id=f"smartrecruiters:{org}:{job_id}",
                    company=company.company_name, title=title,
                    url=_posting_url(job, org, job_id), source=self.provider,
                    external_job_id=job_id, location=_location(job),
                    posted_date=date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) else "",
                    description=_description(job) or None,
                ))
            # Bound raw rows, not only accepted jobs: malformed/duplicate pages
            # must not create unbounded requests. Never follow payload ref URLs.
            offset += min(len(jobs), limit)
            total = payload.get("totalFound")
            if new_ids == 0 or (isinstance(total, int) and not isinstance(total, bool) and offset >= total):
                break
            if not isinstance(total, int) and len(jobs) < limit:
                break
        return out

    def get_job(self, company: CompanyRecord, candidate: LightweightCandidate) -> LightweightCandidate:
        org = _company_identifier(company)
        job_id = (candidate.external_job_id or "").strip()
        if not _JOB_ID_RE.fullmatch(job_id):
            raise AdapterError("smartrecruiters requires a numeric posting id", category="validation")
        response = self.http.get(f"https://api.smartrecruiters.com/v1/companies/{org}/postings/{job_id}")
        try:
            job = response.json()
        except ValueError:
            raise AdapterError("smartrecruiters detail response is not JSON", category="validation") from None
        if not isinstance(job, dict) or str(job.get("id") or "") != job_id:
            raise AdapterError("smartrecruiters detail identity mismatch", category="validation")
        owner = job.get("company")
        if isinstance(owner, dict) and owner.get("identifier") and str(owner["identifier"]).lower() != org.lower():
            raise AdapterError("smartrecruiters detail company mismatch", category="validation")
        if job.get("active") is False:
            raise AdapterError("smartrecruiters posting is no longer active", category="not_found")
        if job.get("visibility", "PUBLIC") != "PUBLIC":
            raise AdapterError("smartrecruiters posting is not public", category="validation")
        return replace(candidate, title=str(job.get("name") or candidate.title).strip(),
                       url=_posting_url(job, org, job_id),
                       location=_location(job) or candidate.location,
                       description=_description(job) or candidate.description)
