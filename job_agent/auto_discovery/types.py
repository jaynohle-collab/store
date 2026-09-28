"""Shared types for automatic discovery."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class LightweightCandidate:
    """Preflight-ready candidate (no scores/decisions/reasoning)."""

    client_candidate_id: str
    company: str
    title: str
    url: str
    source: str
    external_job_id: str = ""
    location: str = ""
    posted_date: str = ""
    description_hash: str = ""
    description: str | None = None

    def to_preflight_dict(self) -> dict[str, str]:
        return {
            "client_candidate_id": self.client_candidate_id,
            "company": self.company,
            "title": self.title,
            "url": self.url,
            "source": self.source,
            "external_job_id": self.external_job_id or "",
            "location": self.location or "",
            "posted_date": self.posted_date or "",
            "description_hash": self.description_hash or "",
        }


@dataclass(slots=True)
class CompanyRecord:
    """Claimed discovery company registry row + lease run id."""

    id: str
    company_key: str
    company_name: str
    ats_provider: str
    ats_org_id: str | None = None
    careers_url: str | None = None
    scan_priority: str = "normal"
    run_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_claim(cls, claim: dict[str, Any]) -> "CompanyRecord":
        company = claim.get("company") if isinstance(claim.get("company"), dict) else claim
        run = claim.get("run") if isinstance(claim.get("run"), dict) else {}
        return cls(
            id=str(company.get("id") or ""),
            company_key=str(company.get("company_key") or ""),
            company_name=str(company.get("company_name") or ""),
            ats_provider=str(company.get("ats_provider") or ""),
            ats_org_id=(str(company["ats_org_id"]) if company.get("ats_org_id") else None),
            careers_url=(str(company["careers_url"]) if company.get("careers_url") else None),
            scan_priority=str(company.get("scan_priority") or "normal"),
            run_id=str(run.get("id") or company.get("run_id") or "") or None,
            raw=dict(claim),
        )


@dataclass
class RunMetrics:
    companies_claimed: int = 0
    companies_completed: int = 0
    companies_failed: int = 0
    # Capacity / provider pauses released without failure backoff.
    companies_deferred: int = 0
    # Listings returned by ATS list endpoints ("listings fetched").
    candidates_listed: int = 0
    candidates_deterministic_rejected: int = 0
    # Listings that passed structural + persona rejects.
    candidates_normalized: int = 0
    candidates_preflighted: int = 0
    # Preflight skips: known postings, prior applications, duplicates, evidence.
    candidates_skipped: int = 0
    candidates_ranked: int = 0
    candidates_selected: int = 0
    candidates_unchanged_skipped: int = 0
    candidates_below_threshold: int = 0
    full_descriptions_requested: int = 0
    stored_reused: int = 0
    # New LLM evaluations durably persisted.
    candidates_evaluated: int = 0
    candidates_qualified: int = 0
    candidates_rejected: int = 0
    qualified_unsubmitted: int = 0
    batches_submitted: int = 0
    jobs_submitted: int = 0
    llm_calls: int = 0
    estimated_llm_tokens: int = 0
    pending_preserved: int = 0
    listing_requests: int = 0
    rate_limit_responses: int = 0
    http_retries: int = 0
    bytes_downloaded: int = 0
    duration_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)
    submitted_batch_ids: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name in self.__dataclass_fields__:
            value = getattr(self, name)
            out[name] = list(value) if isinstance(value, list) else value
        return out


class AdapterError(RuntimeError):
    """ATS adapter failure with a stable error category for MCP backoff."""

    def __init__(
        self,
        message: str,
        *,
        category: str = "unknown",
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.category = category
        self.status_code = status_code
