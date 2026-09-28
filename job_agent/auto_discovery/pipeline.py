"""Automatic discovery producer pipeline.

Per claimed company:

1. List lightweight postings from the official ATS (bounded).
2. Structural + persona deterministic rejects (no network, no LLM).
3. Pre-rank by persona score and keep ``max_listings_per_company``.
4. Identity preflight (known postings, prior applications, duplicates) and
   stored-evidence lookup for the active profile generation.
5. Deterministic rank with novelty tiers; select the top 3–5.
6. Fetch full descriptions only for selected listings, then evaluate or reuse
   stored evidence. New LLM calls are bounded globally by ``max_evals_per_run``;
   selected candidates beyond the budget are preserved in the pending queue.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone
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
from job_agent.auto_discovery.ranking import (
    OUTCOME_NO_EVIDENCE,
    OUTCOME_REUSED,
    SELECTION_MEMORY_KEY,
    StoredEvaluationState,
    candidate_key,
    load_selection_memory,
    persona_reject_reason,
    profile_score,
    rank_listings,
    remember,
    trim_selection_memory,
)
from job_agent.auto_discovery.types import (
    AdapterError,
    CompanyRecord,
    LightweightCandidate,
    RunMetrics,
)
from job_agent.lifecycle.url import normalize_url
from job_agent.memory.fingerprint import compute_description_hash
from job_agent.models.types import JobSearchProfile
from job_agent.profile.identity import ProfileIdentity, identity_of, load_active_profile

logger = logging.getLogger(__name__)

# Namespace for deterministic client_evaluation_id (UUIDv5).
_EVAL_ID_NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
_PREFLIGHT_CHUNK = 100
_STATE_LOOKUP_CHUNK = 200
# Server-side idempotency rejection from record_discovery_evaluations.
_IDEMPOTENCY_CONFLICT_MARKER = "already exists with a different evaluation payload"
# Rough prompt overhead for usage estimates (system prompt + rubric).
_PROMPT_OVERHEAD_TOKENS = 900

EVAL_REUSED = "reused"
EVAL_EVALUATED = "evaluated"


class StoredEvaluationMismatchError(RuntimeError):
    """A stored evaluation exists for the deterministic id but identity differs."""


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
        profile: JobSearchProfile | None = None,
    ):
        self.store = store
        self.provider = provider
        self.limits = limits or DiscoveryLimits.from_env(
            max_companies_override=max_companies
        )
        self.http = http
        self._owns_http = http is None
        self.worker_identity = worker_identity
        self.client_evaluation_id_factory = client_evaluation_id_factory
        self.profile = profile or load_active_profile()
        self.identity: ProfileIdentity = identity_of(self.profile)
        self.metrics = RunMetrics()
        self._quota_exhausted = False
        self._paused_reason: str | None = None
        self._pending_claims: list[CompanyRecord] = []
        # Evaluation ids already attached to pending/processing/completed inbox batches.
        self._already_submitted: set[str] = set()
        self._started = time.monotonic()
        self.metrics_extra: dict[str, Any] = {
            "pending_preserved": 0,
            "pending_resumed": 0,
            "pending_completed": 0,
            "pending_eval_reused": 0,
        }

    def _http_client(self) -> SafeHttpClient:
        if self.http is None:
            self.http = SafeHttpClient(max_response_bytes=self.limits.max_response_bytes)
        return self.http

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
                "max_batches_reached",
            }:
                status = "partial"
            elif self.metrics.companies_failed or self.metrics.companies_deferred:
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
                        "metrics": self._run_metrics_payload(),
                        "error_summary": self._paused_reason
                        or (self.metrics.errors[0] if self.metrics.errors else None),
                        "llm_provider": getattr(provider, "name", None),
                    }
                )
            if self._owns_http and self.http is not None:
                self.http.close()
        return self.metrics

    def _run_metrics_payload(self) -> dict[str, Any]:
        http_stats = dict(self.http.stats) if self.http is not None else {}
        self.metrics.listing_requests = int(http_stats.get("requests", 0))
        self.metrics.rate_limit_responses = int(http_stats.get("rate_limited", 0))
        self.metrics.http_retries = int(http_stats.get("retries", 0))
        self.metrics.bytes_downloaded = int(http_stats.get("bytes_downloaded", 0))
        self.metrics.duration_seconds = round(time.monotonic() - self._started, 1)
        self.metrics.pending_preserved = int(self.metrics_extra["pending_preserved"])
        return {
            **self.metrics.as_dict(),
            **self.metrics_extra,
            "profile_id": self.identity.profile_id,
            "profile_version": self.identity.profile_version,
            "limits": {
                "max_companies": self.limits.max_companies,
                "max_listings_per_company": self.limits.max_listings_per_company,
                "top_candidates_per_company": self.limits.top_candidates_per_company,
                "max_evals_per_run": self.limits.max_evals_per_run,
                "max_jobs_per_batch": self.limits.max_jobs_per_batch,
                "max_batches_per_run": self.limits.max_batches_per_run,
                "min_rank_score": self.limits.min_rank_score,
            },
            "quota_exhausted": self._quota_exhausted,
            "paused_reason": self._paused_reason,
            "companies_scanned": self.metrics.companies_completed
            + self.metrics.companies_failed,
            "candidates_found": self.metrics.candidates_listed,
            "qualified": self.metrics.candidates_qualified,
            "submitted": self.metrics.batches_submitted,
        }

    def _fingerprint(self, cand: LightweightCandidate) -> str:
        return (
            f"{EVALUATION_VERSION}|{cand.source}|{cand.external_job_id}|"
            f"{cand.url}|{cand.description_hash}"
            f"{self.identity.evaluation_seed_suffix()}"
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
                # Unfinished claimed rows return to the queue when their lease expires.
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
                await self._evaluate_or_reuse(cand, provider, qualified_jobs)
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

    def _stored_evaluation_matches_candidate(
        self, stored: dict[str, Any], cand: LightweightCandidate
    ) -> bool:
        """Validate identity fields before reusing a stored evaluation."""
        if str(stored.get("evaluation_version") or "") != EVALUATION_VERSION:
            return False
        if not self.identity.matches_stored(stored):
            return False
        if str(stored.get("source") or "") != str(cand.source or ""):
            return False
        if str(stored.get("external_job_id") or "") != str(cand.external_job_id or ""):
            return False
        if str(stored.get("description_hash") or "") != str(
            cand.description_hash or ""
        ):
            return False
        stored_norm = str(stored.get("normalized_url") or "").strip() or normalize_url(
            str(stored.get("url") or "")
        )
        cand_norm = normalize_url(cand.url)
        if not stored_norm or not cand_norm or stored_norm != cand_norm:
            return False
        return True

    def _apply_evaluation_outcome(
        self,
        *,
        cand: LightweightCandidate,
        description: str,
        record: dict[str, Any],
        evaluation_id: str | None,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        if record.get("gpt_decision") == "QUALIFIED":
            if not evaluation_id:
                raise RuntimeError(
                    "record_discovery_evaluations did not return evaluation_id "
                    "for QUALIFIED candidate; refusing submit without evidence"
                )
            self.metrics.candidates_qualified += 1
            qualified_jobs.append(
                self._job_payload(cand, description, record, evaluation_id)
            )
        else:
            self.metrics.candidates_rejected += 1

    async def _evaluate_or_reuse(
        self,
        cand: LightweightCandidate,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> str:
        """Single evaluation entry point for pending resumes and fresh scans.

        Stored evidence for the deterministic client_evaluation_id is reused
        before any LLM request; otherwise evaluate, persist, then count.
        Returns ``EVAL_REUSED`` or ``EVAL_EVALUATED``.
        """
        if await self._reuse_stored_evaluation_if_valid(cand, qualified_jobs):
            return EVAL_REUSED
        return await self._evaluate_and_record(cand, provider, qualified_jobs)

    async def _lookup_stored_evaluation(
        self, client_id: str
    ) -> dict[str, Any] | None:
        if not hasattr(self.store, "get_discovery_evaluation_by_client_id"):
            return None
        lookup = await self.store.get_discovery_evaluation_by_client_id(
            {"client_evaluation_id": client_id}
        )
        stored = (lookup or {}).get("evaluation")
        return stored if isinstance(stored, dict) else None

    def _apply_stored_evaluation(
        self,
        stored: dict[str, Any],
        cand: LightweightCandidate,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        evaluation_id = str(
            stored.get("evaluation_id") or stored.get("id") or ""
        ).strip()
        # Do not increment llm_calls or candidates_evaluated on reuse.
        self._apply_evaluation_outcome(
            cand=cand,
            description=(cand.description or "").strip(),
            record=stored,
            evaluation_id=evaluation_id or None,
            qualified_jobs=qualified_jobs,
        )
        self.metrics_extra["pending_eval_reused"] += 1
        self.metrics.stored_reused += 1

    async def _reuse_stored_evaluation_if_valid(
        self,
        cand: LightweightCandidate,
        qualified_jobs: list[dict[str, Any]],
    ) -> bool:
        """Reuse stored evidence for the deterministic client_evaluation_id.

        Returns True when a matching stored evaluation was applied (no LLM call).
        Raises when a stored row exists for the deterministic id but identity
        fields do not match (fail closed — do not re-call the LLM).
        """
        client_id = self._idempotent_client_id(cand)
        stored = await self._lookup_stored_evaluation(client_id)
        if stored is None:
            return False
        if not self._stored_evaluation_matches_candidate(stored, cand):
            raise StoredEvaluationMismatchError(
                "stored evaluation identity mismatch for client_evaluation_id "
                f"{client_id}; refusing reuse and LLM retry"
            )
        self._apply_stored_evaluation(stored, cand, qualified_jobs)
        return True

    async def _evaluate_and_record(
        self,
        full: LightweightCandidate,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> str:
        description = (full.description or "").strip()
        self.metrics.estimated_llm_tokens += _PROMPT_OVERHEAD_TOKENS + len(description) // 4
        record = evaluate_candidate(provider, full, description)
        # Deterministic id BEFORE record — same fingerprint as pending queue.
        client_id = self._idempotent_client_id(full)
        record["client_evaluation_id"] = client_id
        record["profile_id"] = self.identity.profile_id
        record["profile_version"] = self.identity.profile_version
        # LLM was invoked; count the call even if persistence later conflicts.
        self.metrics.llm_calls += 1

        try:
            recorded = await self.store.record_discovery_evaluations(
                {"evaluations": [record]}
            )
        except Exception as exc:
            if _IDEMPOTENCY_CONFLICT_MARKER not in str(exc):
                raise
            # Lookup-create race: another writer persisted this id first.
            try:
                stored = await self._lookup_stored_evaluation(client_id)
            except Exception:
                stored = None
            if stored is None or not self._stored_evaluation_matches_candidate(
                stored, full
            ):
                raise exc
            logger.info(
                "record conflict for client_evaluation_id %s resolved by reusing "
                "matching stored evaluation",
                client_id,
            )
            self._apply_stored_evaluation(stored, full, qualified_jobs)
            return EVAL_REUSED
        # Only count a successful evaluation after durable persist.
        self.metrics.candidates_evaluated += 1
        evaluation_id = self._extract_evaluation_id(recorded, record)
        self._apply_evaluation_outcome(
            cand=full,
            description=description,
            record=record,
            evaluation_id=evaluation_id,
            qualified_jobs=qualified_jobs,
        )
        return EVAL_EVALUATED

    async def _release_remaining_claims(self) -> None:
        """Release claims that were not scanned (capacity / quota / early stop).

        Capacity and provider-quota pauses complete as deferred: the company is
        immediately re-claimable and ``consecutive_failures`` is untouched.
        Other stop reasons fail closed.
        """
        deferred = self._paused_reason == "max_evals_reached" or self._quota_exhausted
        summary = self._paused_reason or "run_stopped_before_company_scan"
        for company in list(self._pending_claims):
            if not company.run_id:
                continue
            try:
                if deferred:
                    await self.store.complete_discovery_company_run(
                        {
                            "run_id": company.run_id,
                            "success": True,
                            "deferred": True,
                            "worker_identity": self.worker_identity,
                            "metrics": {
                                "deferred_reason": self._deferral_reason(),
                            },
                        }
                    )
                    self.metrics.companies_deferred += 1
                else:
                    await self.store.fail_discovery_company_run(
                        {
                            "run_id": company.run_id,
                            "error_category": "unknown",
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

    def _deferral_reason(self) -> str:
        if self._quota_exhausted:
            return "llm_unavailable"
        return "max_evals_reached"

    async def _preflight(
        self, candidates: list[LightweightCandidate]
    ) -> dict[str, dict[str, Any]]:
        by_key: dict[str, dict[str, Any]] = {}
        for i in range(0, len(candidates), _PREFLIGHT_CHUNK):
            chunk = candidates[i : i + _PREFLIGHT_CHUNK]
            preflight = await self.store.check_discovery_candidates(
                {
                    "evaluation_version": EVALUATION_VERSION,
                    "profile": self.identity.as_filter(),
                    "candidates": [c.to_preflight_dict() for c in chunk],
                }
            )
            for r in list((preflight or {}).get("results") or []):
                if not isinstance(r, dict):
                    continue
                key = str(r.get("client_candidate_id") or r.get("url") or "")
                if key:
                    by_key[key] = r
            self.metrics.candidates_preflighted += len(chunk)
        return by_key

    async def _lookup_states(
        self, candidates: list[LightweightCandidate]
    ) -> dict[str, StoredEvaluationState]:
        if not candidates or not hasattr(
            self.store, "lookup_discovery_evaluation_states"
        ):
            return {}
        states: dict[str, StoredEvaluationState] = {}
        for i in range(0, len(candidates), _STATE_LOOKUP_CHUNK):
            chunk = candidates[i : i + _STATE_LOOKUP_CHUNK]
            by_client_id = {c.client_candidate_id: c for c in chunk}
            result = await self.store.lookup_discovery_evaluation_states(
                {
                    "evaluation_version": EVALUATION_VERSION,
                    "profile": self.identity.as_filter(),
                    "candidates": [
                        {
                            "client_candidate_id": c.client_candidate_id,
                            "url": c.url,
                            "source": c.source,
                            "external_job_id": c.external_job_id or "",
                        }
                        for c in chunk
                    ],
                }
            )
            for raw in list((result or {}).get("states") or []):
                if not isinstance(raw, dict):
                    continue
                cand = by_client_id.get(str(raw.get("client_candidate_id") or ""))
                state = StoredEvaluationState.from_lookup(raw)
                if cand is not None and state is not None:
                    states[candidate_key(cand)] = state
                    if state.submitted_to_inbox and state.evaluation_id:
                        self._already_submitted.add(state.evaluation_id)
        return states

    @staticmethod
    def _with_listing_hash(cand: LightweightCandidate) -> LightweightCandidate:
        """Hash list-time descriptions (Ashby/Lever) so changes are detectable."""
        if cand.description_hash or not (cand.description or "").strip():
            return cand
        return LightweightCandidate(
            client_candidate_id=cand.client_candidate_id,
            company=cand.company,
            title=cand.title,
            url=cand.url,
            source=cand.source,
            external_job_id=cand.external_job_id,
            location=cand.location,
            posted_date=cand.posted_date,
            description_hash=compute_description_hash((cand.description or "").strip()) or "",
            description=cand.description,
        )

    def _skip_after_preflight(self, pf: dict[str, Any]) -> str | None:
        # Reusable QUALIFIED evidence is not skipped here: the state lookup decides
        # whether it was already submitted or must be resubmitted without an LLM call.
        if pf.get("gpt_skip_allowed"):
            return "stored_evidence"
        if pf.get("previously_applied"):
            return "previously_applied"
        status = str(pf.get("identity_status") or "")
        if status == "KNOWN_UNCHANGED":
            return "known_posting"
        if status == "POSSIBLE_CROSS_SOURCE":
            return "known_duplicate"
        return None

    async def _scan_company(
        self,
        company: CompanyRecord,
        provider: EvaluationProvider,
        qualified_jobs: list[dict[str, Any]],
    ) -> None:
        company_run_id = company.run_id
        company_qualified_before = len(qualified_jobs)
        today = datetime.now(timezone.utc).date()
        memory = load_selection_memory(
            (company.raw.get("company") or {}).get("stats")
            if isinstance(company.raw.get("company"), dict)
            else None
        )
        company_metrics: dict[str, Any] = {}
        early_stop = False
        try:
            adapter = get_adapter(company.ats_provider, http=self._http_client())
            if hasattr(adapter, "max_listings"):
                adapter.max_listings = self.limits.max_listings_per_company
            listed = adapter.list_jobs(company)
            self.metrics.candidates_listed += len(listed)

            kept, rejected = filter_deterministic(listed)
            persona_ok: list[LightweightCandidate] = []
            persona_rejected = 0
            for cand in kept:
                if persona_reject_reason(cand, self.profile):
                    persona_rejected += 1
                else:
                    persona_ok.append(cand)
            self.metrics.candidates_deterministic_rejected += len(rejected) + persona_rejected
            self.metrics.candidates_normalized += len(persona_ok)

            # Listing breadth bound, chosen by persona score (never ATS order).
            persona_ok.sort(
                key=lambda c: (-profile_score(c, self.profile), candidate_key(c))
            )
            considered = [
                self._with_listing_hash(c)
                for c in persona_ok[: self.limits.max_listings_per_company]
            ]

            preflight = await self._preflight(considered) if considered else {}
            fresh: list[LightweightCandidate] = []
            for cand in considered:
                pf = preflight.get(cand.client_candidate_id) or preflight.get(cand.url) or {}
                if self._skip_after_preflight(pf):
                    self.metrics.candidates_skipped += 1
                    continue
                fresh.append(cand)

            states = await self._lookup_states(fresh)
            ranking = rank_listings(
                fresh,
                profile=self.profile,
                states=states,
                memory=memory,
                top_k=self.limits.top_candidates_per_company,
                min_rank_score=self.limits.min_rank_score,
                today=today,
            )
            self.metrics.candidates_deterministic_rejected += len(ranking.rejected)
            self.metrics.candidates_ranked += len(ranking.ranked)
            self.metrics.candidates_selected += len(ranking.selected)
            self.metrics.candidates_unchanged_skipped += len(ranking.unchanged)
            self.metrics.candidates_below_threshold += len(ranking.below_threshold)
            company_metrics = {
                "listed": len(listed),
                "considered": len(considered),
                "ranked": len(ranking.ranked),
                "selected": len(ranking.selected),
                "unchanged": len(ranking.unchanged),
                "selected_keys": [r.key for r in ranking.selected],
            }

            to_evaluate: list[tuple[LightweightCandidate, str]] = []
            for item in ranking.selected:
                self.metrics.full_descriptions_requested += 1
                try:
                    full = adapter.get_job(company, item.candidate)
                except AdapterError as exc:
                    # One bad posting must not fail the company or starve the rest.
                    self.metrics_extra["detail_fetch_errors"] = (
                        int(self.metrics_extra.get("detail_fetch_errors", 0)) + 1
                    )
                    if exc.category in {"not_found", "validation", "ssrf_blocked"}:
                        remember(
                            memory,
                            item.key,
                            outcome=OUTCOME_NO_EVIDENCE,
                            posted_date=item.candidate.posted_date,
                            today=today,
                        )
                    continue
                description = (full.description or item.candidate.description or "").strip()
                if not description:
                    self.metrics.candidates_deterministic_rejected += 1
                    remember(
                        memory,
                        item.key,
                        outcome=OUTCOME_NO_EVIDENCE,
                        posted_date=item.candidate.posted_date,
                        today=today,
                    )
                    continue
                to_evaluate.append(
                    (
                        LightweightCandidate(
                            client_candidate_id=full.client_candidate_id,
                            company=full.company,
                            title=full.title,
                            url=full.url,
                            source=full.source,
                            external_job_id=full.external_job_id,
                            location=full.location,
                            posted_date=full.posted_date,
                            description_hash=compute_description_hash(description) or "",
                            description=description,
                        ),
                        item.key,
                    )
                )

            for index, (full, key) in enumerate(to_evaluate):
                remaining = [c for c, _ in to_evaluate[index:]]
                if self._quota_exhausted:
                    early_stop = True
                    await self._preserve_candidates(
                        remaining, company=company, reason="providers_unavailable_mid_company"
                    )
                    break
                if self.metrics.candidates_evaluated >= self.limits.max_evals_per_run:
                    # Stored evidence can still be reused without LLM capacity.
                    if await self._reuse_stored_evaluation_if_valid(full, qualified_jobs):
                        remember(
                            memory,
                            key,
                            outcome=OUTCOME_REUSED,
                            posted_date=full.posted_date,
                            today=today,
                        )
                        continue
                    early_stop = True
                    self._paused_reason = self._paused_reason or "max_evals_reached"
                    await self._preserve_candidates(
                        remaining, company=company, reason="max_evals_reached"
                    )
                    break

                try:
                    outcome = await self._evaluate_or_reuse(full, provider, qualified_jobs)
                    if outcome == EVAL_REUSED:
                        remember(
                            memory,
                            key,
                            outcome=OUTCOME_REUSED,
                            posted_date=full.posted_date,
                            today=today,
                        )
                    else:
                        memory.pop(key, None)
                except AllProvidersUnavailableError as exc:
                    self._quota_exhausted = True
                    self._paused_reason = f"all_providers_unavailable:{exc}"
                    early_stop = True
                    await self._preserve_candidates(
                        remaining, company=company, reason="all_providers_unavailable"
                    )
                    break
                except QuotaExhaustedError as exc:
                    self._quota_exhausted = True
                    self._paused_reason = f"llm_quota:{exc}"
                    early_stop = True
                    await self._preserve_candidates(
                        remaining, company=company, reason="llm_quota"
                    )
                    break
                except InvalidModelOutputError:
                    self.metrics.candidates_rejected += 1
                    remember(
                        memory,
                        key,
                        outcome=OUTCOME_NO_EVIDENCE,
                        posted_date=full.posted_date,
                        today=today,
                    )
                    continue

            if company_run_id:
                company_metrics["qualified_delta"] = (
                    len(qualified_jobs) - company_qualified_before
                )
                company_metrics[SELECTION_MEMORY_KEY] = trim_selection_memory(memory, today)
                if early_stop:
                    # Capacity / provider pause: candidates are preserved; release
                    # without failure backoff or consecutive_failures.
                    company_metrics["deferred_reason"] = self._deferral_reason()
                    await self.store.complete_discovery_company_run(
                        {
                            "run_id": company_run_id,
                            "success": True,
                            "deferred": True,
                            "worker_identity": self.worker_identity,
                            "metrics": company_metrics,
                        }
                    )
                    self.metrics.companies_completed += 1
                    self.metrics.companies_deferred += 1
                else:
                    await self.store.complete_discovery_company_run(
                        {
                            "run_id": company_run_id,
                            "success": True,
                            "worker_identity": self.worker_identity,
                            "metrics": company_metrics,
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
        unique: list[dict[str, Any]] = []
        seen: set[str] = set()
        for job in jobs:
            attachment = job.get("gpt_evaluation")
            eid = str(attachment.get("evaluation_id") or "") if isinstance(attachment, dict) else ""
            if eid and (eid in seen or eid in self._already_submitted):
                self.metrics_extra["already_submitted_skipped"] = (
                    int(self.metrics_extra.get("already_submitted_skipped", 0)) + 1
                )
                continue
            if eid:
                seen.add(eid)
            unique.append(job)
        jobs = unique
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
                # Evidence stays stored; unsubmitted QUALIFIED jobs are selected
                # again (without LLM) on the company's next scan.
                self._paused_reason = self._paused_reason or "max_batches_reached"
                self.metrics.qualified_unsubmitted += len(jobs) - i
                break
            chunk = jobs[i : i + self.limits.max_jobs_per_batch]
            client_batch_id = str(
                uuid.uuid5(
                    _EVAL_ID_NAMESPACE,
                    "batch|"
                    + "|".join(
                        sorted(str(j["gpt_evaluation"]["evaluation_id"]) for j in chunk)
                    ),
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
            self.metrics.jobs_submitted += len(chunk)
            batches += 1
