"""Automatic discovery producer pipeline."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Callable

from job_agent.auto_discovery.adapters.registry import get_adapter
from job_agent.auto_discovery.deterministic import filter_deterministic
from job_agent.auto_discovery.evaluate.gpt_fit_v2 import (
    EVALUATION_VERSION,
    NORMALIZATION_VERSION,
    InvalidModelOutputError,
    evaluate_candidate,
)
from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    EvaluationProvider,
    QuotaExhaustedError,
    resolve_provider,
)
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.types import (
    AdapterError,
    CompanyRecord,
    LightweightCandidate,
    RunMetrics,
)
from job_agent.memory.fingerprint import compute_description_hash

logger = logging.getLogger(__name__)

# Namespace for deterministic client_evaluation_id (UUIDv5).
_EVAL_ID_NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
_PREFLIGHT_CHUNK = 100


class AutomaticDiscoveryPipeline:
    def __init__(
        self,
        store: Any,
        *,
        provider: EvaluationProvider | None = None,
        http: SafeHttpClient | None = None,
        limits: DiscoveryLimits | None = None,
        max_companies: int | None = None,
        worker_identity: str = "automatic-discovery",
        client_evaluation_id_factory: Callable[[str], str] | None = None,
    ):
        self.store = store
        self.provider = provider
        self.http = http
        self.limits = limits or DiscoveryLimits.from_env(
            max_companies_override=max_companies
        )
        self.worker_identity = worker_identity
        self.client_evaluation_id_factory = client_evaluation_id_factory
        self.metrics = RunMetrics()
        self._quota_exhausted = False
        self._paused_reason: str | None = None
        self._pending_claims: list[CompanyRecord] = []
        self.metrics_extra: dict[str, Any] = {
            "pending_preserved": 0,
            "pending_resumed": 0,
            "pending_completed": 0,
        }

    async def run(self) -> RunMetrics:
        provider = self.provider or resolve_provider()
        run = await self.store.start_automatic_discovery_run(
            {
                "worker_identity": self.worker_identity,
                "llm_provider": getattr(provider, "name", None),
            }
        )
        run_id = str((run or {}).get("id") or "")
        status = "completed"
        qualified_jobs: list[dict[str, Any]] = []
        try:
            # Resume durably preserved candidates before scanning new ATS listings.
            await self._process_pending_evaluations(provider, qualified_jobs)

            if not self._quota_exhausted:
                claim = await self.store.claim_due_discovery_companies(
                    {
                        "limit": self.limits.max_companies,
                        "lease_minutes": 30,
                        "worker_identity": self.worker_identity,
                        "recover_stale": True,
                    }
                )
                claims = list((claim or {}).get("claims") or [])
                self.metrics.companies_claimed = len(claims)
                self._pending_claims = [
                    CompanyRecord.from_claim(dict(raw)) for raw in claims
                ]

                for company in list(self._pending_claims):
                    if self._quota_exhausted:
                        break
                    if self.metrics.candidates_evaluated >= self.limits.max_evals_per_run:
                        self._paused_reason = self._paused_reason or "max_evals_reached"
                        break
                    await self._scan_company(company, provider, qualified_jobs)
                    self._pending_claims = [
                        c for c in self._pending_claims if c.run_id != company.run_id
                    ]

            # Always submit QUALIFIED jobs collected so far before pausing.
            await self._submit_batches(qualified_jobs)
            if self._quota_exhausted or self._paused_reason in {
                "max_evals_reached",
                "all_providers_unavailable",
            }:
                status = "partial"
            elif not qualified_jobs and self.metrics.companies_failed:
                status = "partial"
        except Exception as exc:
            status = "failed"
            self.metrics.errors.append(str(exc)[:500])
            logger.exception("automatic discovery run failed")
        finally:
            await self._release_remaining_claims()
            if run_id:
                finish_status = status
                if self._quota_exhausted and status == "completed":
                    finish_status = "partial"
                await self.store.finish_automatic_discovery_run(
                    {
                        "run_id": run_id,
                        "status": finish_status,
                        "metrics": {
                            **self.metrics.as_dict(),
                            **self.metrics_extra,
                            "quota_exhausted": self._quota_exhausted,
                            "paused_reason": self._paused_reason,
                            "companies_scanned": self.metrics.companies_completed
                            + self.metrics.companies_failed,
                            "candidates_found": self.metrics.candidates_listed,
                            "qualified": self.metrics.candidates_qualified,
                            "submitted": self.metrics.batches_submitted,
                        },
                        "error_summary": self._paused_reason
                        or (self.metrics.errors[0] if self.metrics.errors else None),
                        "llm_provider": getattr(provider, "name", None),
                    }
                )
        return self.metrics

    def _fingerprint(self, cand: LightweightCandidate) -> str:
        return (
            f"{EVALUATION_VERSION}|{cand.source}|{cand.external_job_id}|"
            f"{cand.url}|{cand.description_hash}"
        )

    def _pending_item(
        self, cand: LightweightCandidate, *, company: CompanyRecord | None = None
    ) -> dict[str, Any]:
        return {
            "fingerprint": self._fingerprint(cand),
            "company_id": company.id if company and company.id else None,
            "company_key": company.company_key if company else None,
            "client_candidate_id": cand.client_candidate_id,
            "company": cand.company,
            "title": cand.title,
            "url": cand.url,
            "source": cand.source,
            "external_job_id": cand.external_job_id or "",
            "location": cand.location or "",
            "posted_date": cand.posted_date or "",
            "description": cand.description or "",
            "description_hash": cand.description_hash,
        }

    async def _preserve_candidates(
        self,
        candidates: list[LightweightCandidate],
        *,
        company: CompanyRecord | None = None,
        reason: str,
    ) -> None:
        items = [
            self._pending_item(c, company=company)
            for c in candidates
            if (c.description or "").strip() and c.description_hash
        ]
        if not items:
            return
        if not hasattr(self.store, "preserve_pending_discovery_evaluations"):
            logger.error(
                "store cannot preserve pending evaluations; %s candidates at risk (%s)",
                len(items),
                reason,
            )
            self.metrics.errors.append(f"preserve_unavailable:{reason}"[:500])
            return
        result = await self.store.preserve_pending_discovery_evaluations(
            {"items": items}
        )
        saved = int((result or {}).get("saved_count") or len(items))
        self.metrics_extra["pending_preserved"] += saved
        logger.info("Preserved %s pending evaluation candidate(s): %s", saved, reason)

    async def _process_pending_evaluations(
        self,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        if not hasattr(self.store, "claim_pending_discovery_evaluations"):
            return
        remaining_budget = max(
            0, self.limits.max_evals_per_run - self.metrics.candidates_evaluated
        )
        if remaining_budget <= 0:
            return
        claimed = await self.store.claim_pending_discovery_evaluations(
            {
                "limit": min(remaining_budget, 50),
                "lease_minutes": 30,
                "worker_identity": self.worker_identity,
            }
        )
        items = list((claimed or {}).get("items") or [])
        self.metrics_extra["pending_resumed"] += len(items)
        for row in items:
            if self._quota_exhausted:
                # Re-preserve unfinished claimed rows as pending via complete abandoned?
                # Leave lease to expire back to claimable; also push preserve for safety.
                break
            if self.metrics.candidates_evaluated >= self.limits.max_evals_per_run:
                break
            cand = LightweightCandidate(
                client_candidate_id=str(row.get("client_candidate_id") or ""),
                company=str(row.get("company") or ""),
                title=str(row.get("title") or ""),
                url=str(row.get("url") or ""),
                source=str(row.get("source") or ""),
                external_job_id=str(row.get("external_job_id") or ""),
                location=str(row.get("location") or ""),
                posted_date=str(row.get("posted_date") or ""),
                description_hash=str(row.get("description_hash") or ""),
                description=str(row.get("description") or ""),
            )
            pending_id = str(row.get("id") or "")
            try:
                await self._evaluate_and_record(cand, provider, qualified_jobs)
                if pending_id and hasattr(
                    self.store, "complete_pending_discovery_evaluation"
                ):
                    await self.store.complete_pending_discovery_evaluation(
                        {
                            "id": pending_id,
                            "status": "completed",
                            "worker_identity": self.worker_identity,
                        }
                    )
                    self.metrics_extra["pending_completed"] += 1
            except AllProvidersUnavailableError as exc:
                self._quota_exhausted = True
                self._paused_reason = f"all_providers_unavailable:{exc}"
                await self._preserve_candidates([cand], reason="all_providers_down")
                break
            except QuotaExhaustedError as exc:
                self._quota_exhausted = True
                self._paused_reason = f"llm_quota:{exc}"
                await self._preserve_candidates([cand], reason="llm_quota")
                break
            except InvalidModelOutputError:
                self.metrics.candidates_rejected += 1
                if pending_id and hasattr(
                    self.store, "complete_pending_discovery_evaluation"
                ):
                    await self.store.complete_pending_discovery_evaluation(
                        {
                            "id": pending_id,
                            "status": "abandoned",
                            "last_error": "invalid_model_output",
                            "worker_identity": self.worker_identity,
                        }
                    )

    async def _evaluate_and_record(
        self,
        full: LightweightCandidate,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        description = (full.description or "").strip()
        record = evaluate_candidate(provider, full, description)
        # Deterministic id BEFORE record — same fingerprint as pending queue.
        record["client_evaluation_id"] = self._idempotent_client_id(full)
        self.metrics.candidates_evaluated += 1
        self.metrics.llm_calls += 1

        recorded = await self.store.record_discovery_evaluations(
            {"evaluations": [record]}
        )
        evaluation_id = self._extract_evaluation_id(recorded, record)
        if record.get("gpt_decision") == "QUALIFIED":
            if not evaluation_id:
                raise RuntimeError(
                    "record_discovery_evaluations did not return evaluation_id "
                    "for QUALIFIED candidate; refusing submit without evidence"
                )
            self.metrics.candidates_qualified += 1
            qualified_jobs.append(
                self._job_payload(full, description, record, evaluation_id)
            )
        else:
            self.metrics.candidates_rejected += 1

    async def _release_remaining_claims(self) -> None:
        """Fail-closed release for claims not completed (quota / early stop)."""
        category = "llm_quota" if self._quota_exhausted else "unknown"
        summary = self._paused_reason or "run_stopped_before_company_scan"
        for company in list(self._pending_claims):
            if not company.run_id:
                continue
            try:
                await self.store.fail_discovery_company_run(
                    {
                        "run_id": company.run_id,
                        "error_category": category,
                        "error_summary": summary[:500],
                        "worker_identity": self.worker_identity,
                    }
                )
                self.metrics.companies_failed += 1
            except Exception as exc:
                logger.warning(
                    "failed to release claim for %s: %s",
                    company.company_key,
                    type(exc).__name__,
                )
        self._pending_claims = []

    async def _scan_company(
        self,
        company: CompanyRecord,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        company_run_id = company.run_id
        company_qualified_before = len(qualified_jobs)
        early_stop = False
        try:
            adapter = get_adapter(company.ats_provider, http=self.http)
            listed = adapter.list_jobs(company)
            candidates = listed[: self.limits.max_candidates_per_company]
            self.metrics.candidates_listed += len(candidates)
            kept, rejected = filter_deterministic(candidates)
            self.metrics.candidates_deterministic_rejected += len(rejected)

            by_key: dict[str, dict[str, Any]] = {}
            if kept:
                for i in range(0, len(kept), _PREFLIGHT_CHUNK):
                    chunk = kept[i : i + _PREFLIGHT_CHUNK]
                    preflight = await self.store.check_discovery_candidates(
                        {
                            "evaluation_version": EVALUATION_VERSION,
                            "candidates": [c.to_preflight_dict() for c in chunk],
                        }
                    )
                    results = list((preflight or {}).get("results") or [])
                    for r in results:
                        if not isinstance(r, dict):
                            continue
                        key = str(
                            r.get("client_candidate_id") or r.get("url") or ""
                        )
                        if key:
                            by_key[key] = r
                    self.metrics.candidates_preflighted += len(chunk)

            to_evaluate: list[LightweightCandidate] = []
            for cand in kept:
                pf = by_key.get(cand.client_candidate_id) or by_key.get(cand.url) or {}
                if pf.get("gpt_skip_allowed") or pf.get("gpt_reuse_allowed"):
                    self.metrics.candidates_skipped += 1
                    continue
                if str(pf.get("identity_status") or "") in {
                    "duplicate",
                    "already_applied",
                    "known_posting",
                }:
                    self.metrics.candidates_skipped += 1
                    continue

                full = adapter.get_job(company, cand)
                description = (full.description or cand.description or "").strip()
                if not description:
                    self.metrics.candidates_deterministic_rejected += 1
                    continue
                desc_hash = compute_description_hash(description) or ""
                to_evaluate.append(
                    LightweightCandidate(
                        client_candidate_id=full.client_candidate_id,
                        company=full.company,
                        title=full.title,
                        url=full.url,
                        source=full.source,
                        external_job_id=full.external_job_id,
                        location=full.location,
                        posted_date=full.posted_date,
                        description_hash=desc_hash,
                        description=description,
                    )
                )

            for index, full in enumerate(to_evaluate):
                if self._quota_exhausted:
                    early_stop = True
                    await self._preserve_candidates(
                        to_evaluate[index:],
                        company=company,
                        reason="providers_unavailable_mid_company",
                    )
                    break
                if self.metrics.candidates_evaluated >= self.limits.max_evals_per_run:
                    early_stop = True
                    self._paused_reason = self._paused_reason or "max_evals_reached"
                    await self._preserve_candidates(
                        to_evaluate[index:],
                        company=company,
                        reason="max_evals_reached",
                    )
                    break

                try:
                    await self._evaluate_and_record(full, provider, qualified_jobs)
                except AllProvidersUnavailableError as exc:
                    self._quota_exhausted = True
                    self._paused_reason = f"all_providers_unavailable:{exc}"
                    early_stop = True
                    await self._preserve_candidates(
                        to_evaluate[index:],
                        company=company,
                        reason="all_providers_unavailable",
                    )
                    break
                except QuotaExhaustedError as exc:
                    self._quota_exhausted = True
                    self._paused_reason = f"llm_quota:{exc}"
                    early_stop = True
                    await self._preserve_candidates(
                        to_evaluate[index:],
                        company=company,
                        reason="llm_quota",
                    )
                    break
                except InvalidModelOutputError:
                    self.metrics.candidates_rejected += 1
                    continue

            if company_run_id:
                if early_stop:
                    await self.store.fail_discovery_company_run(
                        {
                            "run_id": company_run_id,
                            "error_category": (
                                "llm_quota" if self._quota_exhausted else "unknown"
                            ),
                            "error_summary": (
                                self._paused_reason or "company_scan_incomplete"
                            )[:500],
                            "worker_identity": self.worker_identity,
                            "metrics": {
                                "listed": len(candidates),
                                "qualified_delta": len(qualified_jobs)
                                - company_qualified_before,
                            },
                        }
                    )
                    self.metrics.companies_failed += 1
                else:
                    await self.store.complete_discovery_company_run(
                        {
                            "run_id": company_run_id,
                            "success": True,
                            "worker_identity": self.worker_identity,
                            "metrics": {
                                "listed": len(candidates),
                                "qualified_delta": len(qualified_jobs)
                                - company_qualified_before,
                            },
                        }
                    )
                    self.metrics.companies_completed += 1
        except AdapterError as exc:
            self.metrics.companies_failed += 1
            self.metrics.errors.append(f"{company.company_key}:{exc}"[:500])
            if company_run_id:
                await self.store.fail_discovery_company_run(
                    {
                        "run_id": company_run_id,
                        "error_category": exc.category,
                        "error_summary": str(exc)[:500],
                        "worker_identity": self.worker_identity,
                    }
                )
        except Exception as exc:
            self.metrics.companies_failed += 1
            self.metrics.errors.append(f"{company.company_key}:{exc}"[:500])
            if company_run_id:
                await self.store.fail_discovery_company_run(
                    {
                        "run_id": company_run_id,
                        "error_category": "unknown",
                        "error_summary": str(exc)[:500],
                        "worker_identity": self.worker_identity,
                    }
                )

    def _idempotent_client_id(self, cand: LightweightCandidate) -> str:
        seed = self._fingerprint(cand)
        if self.client_evaluation_id_factory is not None:
            return self.client_evaluation_id_factory(seed)
        return str(uuid.uuid5(_EVAL_ID_NAMESPACE, seed))

    @staticmethod
    def _extract_evaluation_id(
        recorded: Any, record: dict[str, Any]
    ) -> str | None:
        evaluations = []
        if isinstance(recorded, dict):
            evaluations = list(recorded.get("evaluations") or [])
        client_id = str(record.get("client_evaluation_id") or "")
        for item in evaluations:
            if not isinstance(item, dict):
                continue
            if client_id and str(item.get("client_evaluation_id") or "") == client_id:
                eid = str(item.get("evaluation_id") or item.get("id") or "").strip()
                if eid:
                    return eid
        if evaluations and isinstance(evaluations[0], dict):
            eid = str(
                evaluations[0].get("evaluation_id") or evaluations[0].get("id") or ""
            ).strip()
            if eid:
                return eid
        return None

    def _job_payload(
        self,
        cand: LightweightCandidate,
        description: str,
        record: dict[str, Any],
        evaluation_id: str,
    ) -> dict[str, Any]:
        """Build submit_discovery_batch job with required gpt_evaluation attachment."""
        attachment: dict[str, Any] = {
            "evaluation_id": evaluation_id,
            "gpt_relevance_score": int(record["gpt_relevance_score"]),
            "gpt_decision": "QUALIFIED",
            "evaluation_version": EVALUATION_VERSION,
            "description_hash": cand.description_hash or record.get("description_hash"),
            "remote_scope": record.get("remote_scope"),
            "direct_posting_url_verified": record.get("direct_posting_url_verified"),
            "normalization_version": record.get("normalization_version")
            or NORMALIZATION_VERSION,
            "posting_status": record.get("posting_status"),
        }
        if record.get("posting_status_verified_at"):
            attachment["posting_status_verified_at"] = record[
                "posting_status_verified_at"
            ]
        if record.get("reasoning_summary"):
            attachment["reasoning_summary"] = str(record["reasoning_summary"])[:1000]

        return {
            "company": cand.company,
            "title": cand.title,
            "url": cand.url,
            "location": cand.location or "",
            "source": cand.source,
            "description": description,
            "required_skills": [],
            "preferred_skills": [],
            "remote_status": "Remote",
            "salary": "",
            "posted_date": cand.posted_date or "",
            "gpt_evaluation": attachment,
        }

    async def _submit_batches(self, jobs: list[dict[str, Any]]) -> None:
        if not jobs:
            return
        # Fail closed: every job must carry a QUALIFIED gpt_evaluation attachment.
        for index, job in enumerate(jobs):
            attachment = job.get("gpt_evaluation")
            if not isinstance(attachment, dict) or not attachment.get("evaluation_id"):
                raise RuntimeError(
                    f"refusing submit: job[{index}] missing gpt_evaluation.evaluation_id"
                )
            if attachment.get("gpt_decision") != "QUALIFIED":
                raise RuntimeError(
                    f"refusing submit: job[{index}] gpt_decision is not QUALIFIED"
                )

        batches = 0
        for i in range(0, len(jobs), self.limits.max_jobs_per_batch):
            if batches >= self.limits.max_batches_per_run:
                self._paused_reason = self._paused_reason or "max_batches_reached"
                break
            chunk = jobs[i : i + self.limits.max_jobs_per_batch]
            client_batch_id = str(
                uuid.uuid5(
                    _EVAL_ID_NAMESPACE,
                    f"batch|{self.worker_identity}|{chunk[0]['url']}|{len(chunk)}|{i}",
                )
            )
            batch = await self.store.submit_discovery_batch(
                {
                    "source": "automatic-discovery",
                    "jobs": chunk,
                    "client_batch_id": client_batch_id,
                }
            )
            batch_id = str((batch or {}).get("id") or "")
            if batch_id:
                self.metrics.submitted_batch_ids.append(batch_id)
            self.metrics.batches_submitted += 1
            batches += 1
