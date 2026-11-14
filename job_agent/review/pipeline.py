"""Bounded official ATS collection into a separate human-review lane.

No LLM/provider selection, GPT admission, inbox handoff, or application writes.
Source/network controls are inherited unchanged from the official ATS adapters.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import logging
import hashlib
import time
from typing import Any
import uuid

from job_agent.auto_discovery.adapters.registry import get_adapter
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.types import AdapterError, CompanyRecord, RunMetrics
from job_agent.review.keyword import KeywordPolicy, normalized_posting_url, review_candidates

logger = logging.getLogger(__name__)


def json_identity(candidate) -> str:
    # Internal correlation ID, not canonical/repost identity.
    import json
    return json.dumps([candidate.source, candidate.company, candidate.external_job_id, candidate.url])


@dataclass
class KeywordRunMetrics(RunMetrics):
    review_saved: int = 0
    review_new: int = 0
    review_updated: int = 0
    review_filtered: int = 0
    review_needs_checking: int = 0


class KeywordDiscoveryPipeline:
    def __init__(self, store: Any, *, policy: KeywordPolicy, profile_id: str,
                 limits: DiscoveryLimits | None = None, max_companies: int | None = None,
                 worker_identity: str = "keyword-discovery", http: SafeHttpClient | None = None):
        if not profile_id.strip():
            raise ValueError("profile_id is required")
        self.store = store
        self.policy = policy
        self.profile_id = profile_id
        self.limits = limits or DiscoveryLimits.from_env(max_companies_override=max_companies)
        self.worker_identity = worker_identity
        self.http = http
        self._owns_http = http is None
        self.metrics = KeywordRunMetrics()
        self._pending: list[CompanyRecord] = []
        self.run_id = ""
        self._started = time.monotonic()

    def _http_client(self) -> SafeHttpClient:
        if self.http is None:
            self.http = SafeHttpClient(max_response_bytes=self.limits.max_response_bytes)
        return self.http

    async def run(self) -> KeywordRunMetrics:
        status = "completed"
        try:
            started = await self.store.start_automatic_discovery_run(
                {"worker_identity": self.worker_identity, "llm_provider": None})
            # A stable real run UUID is required for per-run idempotency.
            self.run_id = str(uuid.UUID(str((started or {}).get("id") or "")))
            claimed = await self.store.claim_due_discovery_companies({
                "limit": self.limits.max_companies, "lease_minutes": 30,
                "worker_identity": self.worker_identity, "recover_stale": True})
            self._pending = [CompanyRecord.from_claim(c) for c in (claimed or {}).get("claims", [])]
            self.metrics.companies_claimed = len(self._pending)
            for company in list(self._pending):
                await self._scan(company)
                self._pending.remove(company)
            if self.metrics.companies_failed:
                status = "partial" if self.metrics.companies_completed else "failed"
        except Exception as exc:
            status = "failed"
            self.metrics.errors.append(f"keyword_run:{type(exc).__name__}")
            logger.error("Keyword discovery failed (%s); no LLM fallback", type(exc).__name__)
        finally:
            for company in list(self._pending):
                if company.run_id:
                    try:
                        await self.store.fail_discovery_company_run({
                            "run_id": company.run_id, "worker_identity": self.worker_identity,
                            "error_category": "unknown", "error_summary": "keyword_run_stopped"})
                    except Exception:
                        # Lease expiry recovers the claim. Do not pretend release succeeded.
                        self.metrics.errors.append("keyword_claim_release_failed")
            self._pending = []
            self.metrics.duration_seconds = round(time.monotonic() - self._started, 1)
            if self.run_id:
                try:
                    await self.store.finish_automatic_discovery_run({
                        "run_id": self.run_id, "status": status, "llm_provider": None,
                        "metrics": {**self.metrics.as_dict(), "discovery_mode": "keyword",
                                    "profile_id": self.profile_id,
                                    "policy_version": self.policy.policy_version,
                                    "policy_fingerprint": self.policy.fingerprint()},
                        "error_summary": self.metrics.errors[0] if self.metrics.errors else None})
                except Exception:
                    self.metrics.errors.append("keyword_run_finish_failed")
            if self._owns_http and self.http is not None:
                self.http.close()
        return self.metrics

    async def _scan(self, company: CompanyRecord) -> None:
        try:
            adapter = get_adapter(company.ats_provider, http=self._http_client())
            if hasattr(adapter, "max_listings"):
                adapter.max_listings = self.limits.max_listings_per_company
            listed = adapter.list_jobs(company)
            self.metrics.candidates_listed += len(listed)
            # Preserve every listing the bounded adapter actually returned.
            # Do not add a second per-company window that silently defers rows.
            # Source pagination, HTTP response limits and company caps remain.
            listed.sort(key=lambda c: (c.source, c.external_job_id, c.url, c.title))
            snapshots = [asdict(c) for c in listed]
            # Structural validation precedes preflight; never query arbitrary
            # invalid links or silently guess candidate identity.
            report = review_candidates(snapshots, self.policy)
            invalid_indices = {r["input_index"] for r in report["invalid_rows"]}
            candidates = []
            for index, candidate in enumerate(listed):
                if index in invalid_indices:
                    continue
                # Existing preflight has narrower identity lengths than review
                # storage. Do not truncate identities or poison a whole batch.
                if len(candidate.url) > 2048 or len(candidate.source) > 128 or len(candidate.external_job_id or "") > 256:
                    continue
                raw = candidate.to_preflight_dict()
                raw["client_candidate_id"] = "kw-" + hashlib.sha256(json_identity(candidate).encode()).hexdigest()
                # Only identity/history is needed. Arbitrary source date strings
                # and description hashes are not GPT evidence for this path.
                raw["posted_date"] = ""
                raw["description_hash"] = ""
                if len(raw["location"]) > 512:
                    raw["location"] = ""
                candidates.append(raw)
            history: dict[str, dict] = {}
            for i in range(0, len(candidates), 100):
                chunk = candidates[i:i + 100]
                response = await self.store.check_discovery_candidates({"candidates": chunk})
                by_client = {c["client_candidate_id"]: normalized_posting_url(c["url"]) for c in chunk}
                for row in (response or {}).get("results", []):
                    url = normalized_posting_url(row.get("url") or "") or by_client.get(row.get("client_candidate_id"))
                    if url:
                        previous = history.get(url, {})
                        history[url] = {**previous, **row,
                                        "previously_applied": previous.get("previously_applied") is True or row.get("previously_applied") is True}
                self.metrics.candidates_preflighted += len(chunk)
            applied_urls = [u for u, row in history.items() if row.get("previously_applied") is True]
            report = review_candidates(snapshots, self.policy, applied_urls=applied_urls)
            for item in report["items"]:
                aliases = {a["normalized_url"] for a in item["identity_aliases"]}
                if item["application_history"] != "matched" and not aliases.issubset(history):
                    item["application_history"] = "not_checked"
                    item["warnings"].append("application_history_incomplete")
                    if item["bucket"] != "filtered":
                        item["bucket"] = "needs_checking"
                # Deliberately ignore gpt_skip_allowed, past GPT rejections and
                # admission scores: they are not keyword-review admission rules.
            self.metrics.candidates_normalized += len(report["items"])
            self.metrics.candidates_deterministic_rejected += report["counts"]["invalid"]
            self.metrics.review_filtered += report["counts"]["filtered"]
            self.metrics.review_needs_checking += sum(row["bucket"] == "needs_checking" for row in report["items"])
            self.metrics.candidates_ranked += len(report["items"]) - report["counts"]["filtered"]
            # Preserve the filtered bucket for audit too. No top-K slice or LLM
            # budget limits this separate, authenticated review collection.
            company_saved = 0
            for i in range(0, len(report["items"]), 100):
                chunk = report["items"][i:i + 100]
                saved = await self.store.upsert_keyword_review_candidates({
                    "profile_id": self.profile_id, "policy_version": self.policy.policy_version,
                    "policy_fingerprint": self.policy.fingerprint(), "run_id": self.run_id,
                    "candidates": chunk})
                if int(saved.get("saved_count", -1)) != len(chunk):
                    raise RuntimeError("incomplete_keyword_review_write")
                self.metrics.review_saved += len(chunk)
                company_saved += len(chunk)
                self.metrics.review_new += int(saved.get("new_count", 0))
                self.metrics.review_updated += int(saved.get("updated_count", 0))
            if company.run_id:
                await self.store.complete_discovery_company_run({
                    "run_id": company.run_id, "worker_identity": self.worker_identity,
                    "success": True, "metrics": {"discovery_mode": "keyword",
                    "listed": len(listed), "review_saved": company_saved,
                    "keyword_listing_scan": {"next_offset": 0},
                    "review_inventory_scope": "all_fetched"}})
            self.metrics.companies_completed += 1
        except Exception as exc:
            self.metrics.companies_failed += 1
            category = exc.category if isinstance(exc, AdapterError) else "unknown"
            # No source text, private policy values, response bodies, or secrets
            # are copied into logs/error summaries.
            self.metrics.errors.append(f"keyword_company:{category}:{type(exc).__name__}")
            if company.run_id:
                await self.store.fail_discovery_company_run({
                    "run_id": company.run_id, "worker_identity": self.worker_identity,
                    "error_category": category, "error_summary": f"keyword_scan_failed:{type(exc).__name__}"})
