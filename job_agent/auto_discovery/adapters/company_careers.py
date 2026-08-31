"""Conservative company careers page adapter (JSON-LD JobPosting only)."""

from __future__ import annotations

import json
import logging
import re
from html import unescape

from job_agent.auto_discovery.adapters.base import BaseAtsAdapter
from job_agent.auto_discovery.ssrf import assert_safe_ats_url
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, LightweightCandidate

logger = logging.getLogger(__name__)

_SCRIPT_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.I | re.S,
)
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def _iter_job_postings(node: object) -> list[dict]:
    found: list[dict] = []
    if isinstance(node, dict):
        types = node.get("@type")
        type_list = types if isinstance(types, list) else [types]
        if any(str(t).lower() == "jobposting" for t in type_list if t):
            found.append(node)
        graph = node.get("@graph")
        if isinstance(graph, list):
            for item in graph:
                found.extend(_iter_job_postings(item))
        for value in node.values():
            if isinstance(value, (dict, list)) and value is not graph:
                found.extend(_iter_job_postings(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_iter_job_postings(item))
    return found


class CompanyCareersAdapter(BaseAtsAdapter):
    """Only fetch careers_url when host is allowlisted / matches careers host.

    Parses application/ld+json JobPosting blocks when present; otherwise returns [].
    """

    provider = "company_careers"

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        careers_url = (company.careers_url or "").strip()
        if not careers_url:
            logger.info(
                "company_careers skipped for %s: missing careers_url",
                company.company_key,
            )
            return []

        # Only allowlisted ATS hosts — no arbitrary public careers SSRF.
        try:
            assert_safe_ats_url(careers_url)
        except AdapterError as exc:
            logger.info(
                "company_careers blocked for %s: %s",
                company.company_key,
                exc,
            )
            return []

        try:
            response = self.http.get(
                careers_url,
                headers={"Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"},
            )
        except AdapterError as exc:
            logger.info(
                "company_careers fetch failed for %s: %s",
                company.company_key,
                exc.category,
            )
            return []

        content_type = (response.headers.get("content-type") or "").lower()
        if "html" not in content_type and "json" not in content_type and content_type:
            logger.info(
                "company_careers empty for %s: unexpected content-type",
                company.company_key,
            )
            return []

        html = response.text or ""
        postings: list[dict] = []
        for match in _SCRIPT_RE.finditer(html):
            raw = match.group(1).strip()
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            postings.extend(_iter_job_postings(data))

        if not postings:
            logger.info(
                "company_careers empty for %s: no JobPosting JSON-LD",
                company.company_key,
            )
            return []

        out: list[LightweightCandidate] = []
        for index, posting in enumerate(postings):
            title = str(posting.get("title") or "").strip()
            job_url = str(
                posting.get("url")
                or posting.get("sameAs")
                or (posting.get("identifier") if isinstance(posting.get("identifier"), str) else "")
                or ""
            ).strip()
            if not title or not job_url:
                continue
            try:
                assert_safe_ats_url(job_url)
            except AdapterError:
                continue
            identifier = posting.get("identifier")
            if isinstance(identifier, dict):
                job_id = str(identifier.get("value") or identifier.get("name") or "").strip()
            elif isinstance(identifier, str):
                job_id = identifier.strip()
            else:
                job_id = job_url.rstrip("/").rsplit("/", 1)[-1]
            location = ""
            loc = posting.get("jobLocation")
            if isinstance(loc, dict):
                address = loc.get("address")
                if isinstance(address, dict):
                    location = str(
                        address.get("addressLocality")
                        or address.get("addressRegion")
                        or address.get("name")
                        or ""
                    ).strip()
                else:
                    location = str(loc.get("name") or "").strip()
            description = _strip_html(str(posting.get("description") or ""))
            date_posted = str(posting.get("datePosted") or "")[:10]
            posted = date_posted if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_posted or "") else ""
            out.append(
                LightweightCandidate(
                    client_candidate_id=f"careers:{company.company_key}:{job_id or index}",
                    company=company.company_name,
                    title=title,
                    url=job_url,
                    source="company_careers",
                    external_job_id=job_id or str(index),
                    location=location,
                    posted_date=posted,
                    description=description or None,
                )
            )
        return out

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        # JSON-LD usually embeds description at list time.
        return candidate
