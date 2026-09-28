"""Automatic company expansion for the discovery registry.

Candidate sources are restricted to:

* the curated seed catalog (``data/discovery_company_seeds.json``);
* official ATS posting URLs already present in job history / GPT evidence.

ATS identifiers are never guessed: history candidates are parsed from official
ATS posting URLs with strict patterns. Every candidate is verified against its
official public ATS endpoint (SSRF-guarded, bounded) before Remote MCP promotes
it into the enabled scan registry.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from job_agent.auto_discovery.adapters.registry import get_adapter
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.types import AdapterError, CompanyRecord

logger = logging.getLogger(__name__)

DEFAULT_SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "discovery_company_seeds.json"

VERIFIABLE_PROVIDERS = frozenset({"greenhouse", "ashby", "lever", "workday"})
_COMPANY_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_ORG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._|-]{0,255}$")

_GREENHOUSE_URL_RE = re.compile(
    r"^https://(?:boards|job-boards)\.greenhouse\.io/([A-Za-z0-9][A-Za-z0-9_-]{0,99})/jobs/\d+(?:[/?#]|$)",
    re.IGNORECASE,
)
_ASHBY_URL_RE = re.compile(
    r"^https://jobs\.ashbyhq\.com/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)",
    re.IGNORECASE,
)
_LEVER_URL_RE = re.compile(
    r"^https://jobs\.lever\.co/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)",
    re.IGNORECASE,
)
_WORKDAY_URL_RE = re.compile(
    r"^https://([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,2})\.myworkdayjobs\.com/"
    r"(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]{1,100})/job/",
)

# Verification failures that will never succeed on retry.
_PERMANENT_CATEGORIES = frozenset({"not_found", "validation", "ssrf_blocked"})
_ERROR_CATEGORIES = frozenset(
    {"rate_limit", "timeout", "not_found", "server_error", "network", "validation", "ssrf_blocked", "unknown"}
)


class ExpansionStore(Protocol):
    async def upsert_discovery_company_candidates(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    async def claim_discovery_company_candidates(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    async def record_discovery_company_verification(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    async def list_discovery_posting_url_hints(
        self, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]: ...


def slugify_company_key(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug[:64].strip("-")


def parse_ats_posting_url(url: str) -> tuple[str, str] | None:
    """Return ``(provider, ats_org_id)`` for an official ATS posting URL, else None."""
    raw = (url or "").strip()
    for provider, pattern in (
        ("greenhouse", _GREENHOUSE_URL_RE),
        ("ashby", _ASHBY_URL_RE),
        ("lever", _LEVER_URL_RE),
    ):
        match = pattern.match(raw)
        if match:
            return provider, match.group(1).lower()
    match = _WORKDAY_URL_RE.match(raw)
    if match:
        tenant, shard, site = match.groups()
        return "workday", f"{tenant}|{site}|{tenant}.{shard}.myworkdayjobs.com"
    return None


def careers_url_for(provider: str, org: str) -> str | None:
    if provider == "greenhouse":
        return f"https://boards.greenhouse.io/{org}"
    if provider == "ashby":
        return f"https://jobs.ashbyhq.com/{org}"
    if provider == "lever":
        return f"https://jobs.lever.co/{org}"
    if provider == "workday":
        parts = org.split("|")
        if len(parts) == 3:
            return f"https://{parts[2]}/{parts[1]}"
    return None


def _validated_candidate(
    *,
    company_key: str,
    company_name: str,
    provider: str,
    org: str,
    source: str,
    source_ref: str | None,
    priority: str = "normal",
) -> dict[str, Any] | None:
    key = (company_key or "").strip().lower()
    name = (company_name or "").strip()
    if (
        provider not in VERIFIABLE_PROVIDERS
        or not _COMPANY_KEY_RE.match(key)
        or not name
        or not _ORG_RE.match(org or "")
        or priority not in ("high", "normal", "inactive")
    ):
        return None
    out: dict[str, Any] = {
        "company_key": key,
        "company_name": name[:512],
        "ats_provider": provider,
        "ats_org_id": org,
        "discovery_source": source,
        "suggested_priority": priority,
    }
    careers = careers_url_for(provider, org)
    if careers:
        out["careers_url"] = careers
    if source_ref:
        out["source_ref"] = source_ref[:512]
    return out


def load_seed_catalog(path: Path | None = None) -> list[dict[str, Any]]:
    data = json.loads((path or DEFAULT_SEED_PATH).read_text(encoding="utf-8"))
    version = str(data.get("catalog_version") or "seeds")
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entry in data.get("companies") or []:
        cand = _validated_candidate(
            company_key=str(entry.get("company_key") or ""),
            company_name=str(entry.get("company_name") or ""),
            provider=str(entry.get("ats_provider") or ""),
            org=str(entry.get("ats_org_id") or ""),
            source="seed_catalog",
            source_ref=version,
            priority=str(entry.get("suggested_priority") or "normal"),
        )
        if cand is None:
            logger.warning("skipping invalid seed entry: %s", entry.get("company_key"))
            continue
        ident = (cand["ats_provider"], cand["ats_org_id"].lower())
        if ident in seen:
            continue
        seen.add(ident)
        out.append(cand)
    return out


def history_candidates(hints: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    """Derive candidates from official posting URLs in history (deterministic order)."""
    by_ident: dict[tuple[str, str], dict[str, Any]] = {}
    for hint in sorted(hints, key=lambda h: str(h.get("url") or "")):
        parsed = parse_ats_posting_url(str(hint.get("url") or ""))
        if not parsed:
            continue
        provider, org = parsed
        ident = (provider, org.lower())
        if ident in by_ident:
            continue
        company = str(hint.get("company") or "").strip() or org.split("|")[0]
        cand = _validated_candidate(
            company_key=slugify_company_key(company) or slugify_company_key(org.split("|")[0]),
            company_name=company,
            provider=provider,
            org=org,
            source="posting_history",
            source_ref=str(hint.get("url") or ""),
        )
        if cand is not None:
            by_ident[ident] = cand
    return [by_ident[k] for k in sorted(by_ident)][:limit]


@dataclass
class VerificationResult:
    outcome: str  # verified | failed | rejected
    job_count: int | None = None
    error_category: str | None = None
    error_summary: str | None = None


def verify_candidate(candidate: dict[str, Any], http: SafeHttpClient) -> VerificationResult:
    """List jobs from the official ATS endpoint (bounded) to confirm the org exists."""
    provider = str(candidate.get("ats_provider") or "")
    if provider not in VERIFIABLE_PROVIDERS:
        return VerificationResult(
            "rejected", error_category="validation", error_summary="unsupported provider"
        )
    record = CompanyRecord(
        id=str(candidate.get("id") or ""),
        company_key=str(candidate.get("company_key") or ""),
        company_name=str(candidate.get("company_name") or ""),
        ats_provider=provider,
        ats_org_id=candidate.get("ats_org_id"),
        careers_url=candidate.get("careers_url"),
    )
    try:
        adapter = get_adapter(provider, http=http)
        if hasattr(adapter, "max_listings"):
            adapter.max_listings = 20  # type: ignore[attr-defined]
        jobs = adapter.list_jobs(record)
    except AdapterError as exc:
        category = exc.category if exc.category in _ERROR_CATEGORIES else "unknown"
        outcome = "rejected" if category in _PERMANENT_CATEGORIES else "failed"
        return VerificationResult(outcome, error_category=category, error_summary=str(exc)[:500])
    except Exception as exc:  # noqa: BLE001 - verification must not crash the worker
        return VerificationResult(
            "failed", error_category="unknown", error_summary=type(exc).__name__
        )
    return VerificationResult("verified", job_count=len(jobs))


@dataclass
class ExpansionSummary:
    seeds_offered: int = 0
    history_offered: int = 0
    candidates_inserted: int = 0
    claimed: int = 0
    verified: int = 0
    promoted: int = 0
    failed: int = 0
    rejected: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


class CompanyExpansionWorker:
    def __init__(
        self,
        store: ExpansionStore,
        *,
        limits: DiscoveryLimits | None = None,
        http: SafeHttpClient | None = None,
        worker_identity: str = "company-expansion",
        seed_path: Path | None = None,
        history_limit: int = 50,
    ) -> None:
        self.store = store
        self.limits = limits or DiscoveryLimits.from_env()
        self.http = http
        self.worker_identity = worker_identity
        self.seed_path = seed_path
        self.history_limit = history_limit

    async def _upsert(self, candidates: list[dict[str, Any]], summary: ExpansionSummary) -> None:
        for i in range(0, len(candidates), 100):
            result = await self.store.upsert_discovery_company_candidates(
                {"candidates": candidates[i : i + 100]}
            )
            summary.candidates_inserted += int(result.get("inserted_count") or 0)

    async def run(
        self, *, include_seeds: bool = True, include_history: bool = True
    ) -> ExpansionSummary:
        summary = ExpansionSummary()
        if include_seeds:
            seeds = load_seed_catalog(self.seed_path)
            summary.seeds_offered = len(seeds)
            try:
                await self._upsert(seeds, summary)
            except Exception as exc:  # noqa: BLE001
                summary.errors.append(f"seed_upsert:{type(exc).__name__}")
        if include_history:
            try:
                hints = await self.store.list_discovery_posting_url_hints({"limit": 1000})
                derived = history_candidates(
                    list(hints.get("hints") or []), limit=self.history_limit
                )
                summary.history_offered = len(derived)
                if derived:
                    await self._upsert(derived, summary)
            except Exception as exc:  # noqa: BLE001
                summary.errors.append(f"history_upsert:{type(exc).__name__}")

        limit = max(0, min(20, self.limits.max_verifications_per_run))
        if limit == 0:
            return summary
        claimed = await self.store.claim_discovery_company_candidates(
            {"limit": limit, "lease_minutes": 15, "worker_identity": self.worker_identity}
        )
        candidates = list(claimed.get("candidates") or [])
        summary.claimed = len(candidates)
        http = self.http or SafeHttpClient(max_response_bytes=self.limits.max_response_bytes)
        try:
            for cand in candidates:
                result = verify_candidate(cand, http)
                payload: dict[str, Any] = {
                    "candidate_id": str(cand["id"]),
                    "worker_identity": self.worker_identity,
                    "outcome": result.outcome,
                }
                if result.job_count is not None:
                    payload["verified_job_count"] = result.job_count
                if result.error_category:
                    payload["error_category"] = result.error_category
                if result.error_summary:
                    payload["error_summary"] = result.error_summary
                try:
                    recorded = await self.store.record_discovery_company_verification(payload)
                except Exception as exc:  # noqa: BLE001 - lease expiry retries later
                    summary.errors.append(f"record:{type(exc).__name__}")
                    continue
                if result.outcome == "verified":
                    summary.verified += 1
                    if recorded.get("promoted"):
                        summary.promoted += 1
                elif result.outcome == "rejected":
                    summary.rejected += 1
                else:
                    summary.failed += 1
        finally:
            if self.http is None:
                http.close()
        return summary
